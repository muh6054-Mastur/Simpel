-- ==============================================================================
-- SIMPEL MI AL IHSAN - PERBAIKAN PENYIMPANAN & PEMBARUAN NILAI GURU (LM, STS, SAS)
-- 1. Memperbaiki trigger tr_grade_audit_log agar tidak gagal FK changed_by saat guru
--    mengubah nilai siswa per individu.
-- 2. Memperbaiki trigger updated_at tabel assessments & grades agar memakai waktu UTC
--    standar (now()) sehingga tidak melompat +7 jam di masa depan.
-- 3. Memperkuat is_teacher_of_assignment agar mengenali penugasan berdasarkan pasangan
--    (class_id, subject_id) selain ID penugasan langsung.
-- ==============================================================================

-- 1. Trigger audit perubahan nilai yang aman dan tidak menggagalkan penyimpanan nilai
CREATE OR REPLACE FUNCTION public.track_grade_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_actor_id UUID;
BEGIN
    -- Catat hanya jika nilai angka benar-benar berubah
    IF OLD.score IS DISTINCT FROM NEW.score THEN
        -- Prioritaskan profil auth.uid() yang valid
        SELECT p.id INTO v_actor_id
        FROM public.profiles p
        WHERE p.id = auth.uid()
        LIMIT 1;

        -- Fallback: pemilik penugasan asesmen bila memiliki profil valid
        IF v_actor_id IS NULL THEN
            SELECT p.id INTO v_actor_id
            FROM public.assessments a
            JOIN public.teaching_assignments ta ON ta.id = a.assignment_id
            JOIN public.teachers t ON t.id = ta.teacher_id
            JOIN public.profiles p ON p.id = t.user_id
            WHERE a.id = NEW.assessment_id
            LIMIT 1;
        END IF;

        -- Fallback terakhir: profil admin madrasah jika ada
        IF v_actor_id IS NULL THEN
            SELECT p.id INTO v_actor_id
            FROM public.user_roles ur
            JOIN public.profiles p ON p.id = ur.user_id
            WHERE ur.role = 'admin'
            LIMIT 1;
        END IF;

        IF v_actor_id IS NOT NULL THEN
            BEGIN
                INSERT INTO public.grade_audit_logs (
                    grade_id,
                    student_id,
                    old_score,
                    new_score,
                    changed_by,
                    reason
                ) VALUES (
                    NEW.id,
                    NEW.student_id,
                    OLD.score,
                    NEW.score,
                    v_actor_id,
                    COALESCE(NEW.feedback, 'Pembaruan nilai oleh pengampu melalui sistem')
                );
            EXCEPTION WHEN OTHERS THEN
                -- Jangan sampai kegagalan pencatatan log audit membatalkan penyimpanan nilai
                NULL;
            END;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_grade_audit_log ON public.grades;
CREATE TRIGGER tr_grade_audit_log
AFTER UPDATE ON public.grades
FOR EACH ROW EXECUTE FUNCTION public.track_grade_change();

-- 2. Trigger lock nilai yang aman bila system_settings kosong
CREATE OR REPLACE FUNCTION public.enforce_grade_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_locked BOOLEAN := FALSE;
    v_report_locked BOOLEAN := FALSE;
BEGIN
    SELECT COALESCE(is_report_card_locked, FALSE) INTO v_report_locked
    FROM public.system_settings
    LIMIT 1;

    IF COALESCE(v_report_locked, FALSE) = TRUE AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Akses ditolak: Seluruh periode penilaian dan rapor saat ini sedang dikunci oleh madrasah.';
    END IF;

    SELECT COALESCE(fg.is_locked, FALSE) INTO v_is_locked
    FROM public.assessments a
    JOIN public.final_grades fg ON fg.assignment_id = a.assignment_id AND fg.student_id = NEW.student_id
    WHERE a.id = NEW.assessment_id
    LIMIT 1;

    IF COALESCE(v_is_locked, FALSE) = TRUE AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Akses ditolak: Nilai untuk siswa ini pada mata pelajaran tersebut telah disahkan dan dikunci.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_enforce_grade_lock ON public.grades;
CREATE TRIGGER tr_enforce_grade_lock
BEFORE UPDATE OR DELETE ON public.grades
FOR EACH ROW EXECUTE FUNCTION public.enforce_grade_lock();

-- 3. Timestamp UTC akurat untuk assessments dan grades (mencegah offset +7 jam pada TIMESTAMPTZ)
CREATE OR REPLACE FUNCTION public.handle_updated_at_utc()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_set_updated_at ON public.grades;
CREATE TRIGGER tr_set_updated_at
BEFORE UPDATE ON public.grades
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at_utc();

DROP TRIGGER IF EXISTS tr_set_updated_at ON public.assessments;
CREATE TRIGGER tr_set_updated_at
BEFORE UPDATE ON public.assessments
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at_utc();

-- 4. Perkuat resolusi pengampu penugasan (mendukung ID penugasan maupun pasangan class_id + subject_id)
CREATE OR REPLACE FUNCTION public.is_teacher_of_assignment(target_assignment_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    tid UUID;
BEGIN
    IF public.is_admin() THEN
        RETURN TRUE;
    END IF;

    tid := public.get_current_teacher_id();
    IF tid IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.teaching_assignments ta_target
        JOIN public.teaching_assignments ta_mine
          ON ta_mine.teacher_id = tid
         AND (
             ta_mine.id = ta_target.id
             OR (
                 ta_mine.class_id = ta_target.class_id
                 AND ta_mine.subject_id = ta_target.subject_id
             )
         )
        WHERE ta_target.id = target_assignment_id
    );
END;
$$;
