import { supabase, isSupabaseAvailable, reportSupabaseOutcome } from '../lib/supabaseClient';
import {
  SupervisionRecord,
  SupervisionInstrument,
  SupervisionFollowup,
  FollowupStatus,
} from '../types/database.types';
import {
  DEMO_SUPERVISION_RECORDS,
  DEMO_INSTRUMENTS,
} from '../lib/demoData';
import { academicService } from './academicService';

const STORAGE_KEY = 'simpel_supervision_records';
const INSTRUMENTS_KEY = 'simpel_supervision_instruments';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v?: string | null) => typeof v === 'string' && UUID_REGEX.test(v);

function getLocal<T>(key: string, fallback: T): T {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : fallback;
  } catch {
    return fallback;
  }
}

function setLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error(`Failed to store ${key}:`, err);
  }
}

export const supervisionService = {
  async getRecords(filters?: {
    teacherId?: string;
    academicYearId?: string;
    semesterId?: string;
    supervisionType?: string;
  }): Promise<SupervisionRecord[]> {
    let baseRecords = getLocal<SupervisionRecord[]>(STORAGE_KEY, DEMO_SUPERVISION_RECORDS);

    if (isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('supervision_records')
          .select('*, teacher:teachers(*), class:classes(*), subject:subjects(*), supervisor:profiles(*)')
          .order('supervision_date', { ascending: false });

        reportSupabaseOutcome(error);
        if (!error && Array.isArray(data) && data.length > 0) {
          const seen = new Set(baseRecords.map((r) => r.id));
          const merged = [...baseRecords];
          for (const item of data as SupervisionRecord[]) {
            if (!seen.has(item.id)) {
              merged.push(item);
              seen.add(item.id);
            }
          }
          baseRecords = merged;
        }
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase getRecords fallback:', err);
      }
    }

    const [teachers, classes, subjects] = await Promise.all([
      academicService.getTeachers(),
      academicService.getClasses(),
      academicService.getSubjects(),
    ]);

    let records = baseRecords.map((r) => ({
      ...r,
      teacher: teachers.find((t) => t.id === r.teacher_id) || r.teacher,
      class: classes.find((c) => c.id === r.class_id) || r.class,
      subject: subjects.find((s) => s.id === r.subject_id) || r.subject,
    }));

    if (filters?.teacherId) records = records.filter((r) => r.teacher_id === filters.teacherId);
    if (filters?.academicYearId) records = records.filter((r) => r.academic_year_id === filters.academicYearId);
    if (filters?.semesterId) records = records.filter((r) => r.semester_id === filters.semesterId);
    if (filters?.supervisionType) records = records.filter((r) => r.supervision_type === filters.supervisionType);

    return records.sort((a, b) => b.supervision_date.localeCompare(a.supervision_date));
  },

  async createRecord(
    payload: Omit<SupervisionRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<SupervisionRecord> {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `spv-${Date.now()}`;
    const [teachers, classes, subjects] = await Promise.all([
      academicService.getTeachers(),
      academicService.getClasses(),
      academicService.getSubjects(),
    ]);

    let newRecord: SupervisionRecord = {
      ...payload,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      teacher: teachers.find((t) => t.id === payload.teacher_id),
      class: classes.find((c) => c.id === payload.class_id),
      subject: subjects.find((s) => s.id === payload.subject_id),
      followups: [],
    };

    if (
      isSupabaseAvailable() &&
      isUuid(id) &&
      isUuid(payload.teacher_id) &&
      isUuid(payload.academic_year_id) &&
      isUuid(payload.semester_id)
    ) {
      try {
        let supervisorId = isUuid(payload.supervisor_id) ? payload.supervisor_id : '';
        if (!supervisorId) {
          const { data: sessionData } = await supabase.auth.getSession();
          if (isUuid(sessionData?.session?.user?.id)) supervisorId = sessionData!.session!.user!.id;
        }
        if (isUuid(supervisorId)) {
          const { teacher: _t, class: _c, subject: _s, supervisor: _sup, results: _res, followups: _f, ...rawDbPayload } = newRecord;
          const dbPayload = {
            ...rawDbPayload,
            supervisor_id: supervisorId,
            instrument_id: isUuid(rawDbPayload.instrument_id) ? rawDbPayload.instrument_id : null,
            class_id: isUuid(rawDbPayload.class_id) ? rawDbPayload.class_id : null,
            subject_id: isUuid(rawDbPayload.subject_id) ? rawDbPayload.subject_id : null,
            assignment_id: isUuid(rawDbPayload.assignment_id) ? rawDbPayload.assignment_id : null,
          };
          const { data, error } = await supabase.from('supervision_records').insert(dbPayload).select().single();
          reportSupabaseOutcome(error);
          if (!error && data) {
            newRecord = {
              ...(data as SupervisionRecord),
              teacher: newRecord.teacher,
              class: newRecord.class,
              subject: newRecord.subject,
            };
          }
        }
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase createRecord fallback:', err);
      }
    }

    const current = getLocal<SupervisionRecord[]>(STORAGE_KEY, DEMO_SUPERVISION_RECORDS);
    const updated = [newRecord, ...current.filter((r) => r.id !== newRecord.id)];
    setLocal(STORAGE_KEY, updated);
    return newRecord;
  },

  async updateRecord(id: string, updates: Partial<SupervisionRecord>): Promise<SupervisionRecord> {
    const records = await this.getRecords();
    const existing = records.find((r) => r.id === id);
    if (!existing) throw new Error('Data supervisi tidak ditemukan');

    const updatedRecord: SupervisionRecord = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (isSupabaseAvailable() && isUuid(id)) {
      try {
        const { teacher: _t, class: _c, subject: _s, supervisor: _sup, results: _res, followups: _f, ...dbUpdates } = updates;
        const { error } = await supabase.from('supervision_records').update(dbUpdates).eq('id', id);
        reportSupabaseOutcome(error);
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase updateRecord fallback:', err);
      }
    }

    const current = getLocal<SupervisionRecord[]>(STORAGE_KEY, DEMO_SUPERVISION_RECORDS);
    const updatedList = current.some((r) => r.id === id)
      ? current.map((r) => (r.id === id ? updatedRecord : r))
      : [updatedRecord, ...current];
    setLocal(STORAGE_KEY, updatedList);
    return updatedRecord;
  },

  async getInstruments(): Promise<SupervisionInstrument[]> {
    if (isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase.from('supervision_instruments').select('*').eq('is_active', true);
        reportSupabaseOutcome(error);
        if (!error && data && data.length > 0) return data as SupervisionInstrument[];
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase getInstruments fallback:', err);
      }
    }
    return getLocal<SupervisionInstrument[]>(INSTRUMENTS_KEY, DEMO_INSTRUMENTS);
  },

  async addFollowup(
    supervisionRecordId: string,
    activityDescription: string,
    personInCharge: string,
    targetDate: string
  ): Promise<SupervisionFollowup> {
    const newFollowup: SupervisionFollowup = {
      id: `fup-${Date.now()}`,
      supervision_record_id: supervisionRecordId,
      activity_description: activityDescription,
      person_in_charge: personInCharge,
      target_date: targetDate,
      status: 'Dalam_Proses',
      result_notes: null,
      completion_date: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const records = await this.getRecords();
    const rec = records.find((r) => r.id === supervisionRecordId);
    if (rec) {
      rec.followups = [...(rec.followups || []), newFollowup];
      setLocal(STORAGE_KEY, records);
    }
    return newFollowup;
  },

  async updateFollowupStatus(
    recordId: string,
    followupId: string,
    status: FollowupStatus,
    resultNotes?: string
  ): Promise<void> {
    const records = await this.getRecords();
    const rec = records.find((r) => r.id === recordId);
    if (rec && rec.followups) {
      rec.followups = rec.followups.map((f) =>
        f.id === followupId
          ? {
              ...f,
              status,
              result_notes: resultNotes !== undefined ? resultNotes : f.result_notes,
              completion_date: status === 'Selesai' ? new Date().toISOString().split('T')[0] : f.completion_date,
              updated_at: new Date().toISOString(),
            }
          : f
      );
      setLocal(STORAGE_KEY, records);
    }
  },
};
