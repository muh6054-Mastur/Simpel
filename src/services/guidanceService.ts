import { supabase, isSupabaseAvailable, reportSupabaseOutcome } from '../lib/supabaseClient';
import { StudentGuidanceRecord, GuidanceStatus } from '../types/database.types';
import { DEMO_GUIDANCES, DEMO_STUDENTS } from '../lib/demoData';

const STORAGE_KEY = 'simpel_student_guidance';

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v?: string | null) => typeof v === 'string' && UUID_REGEX.test(v);

export const guidanceService = {
  async getGuidanceRecords(userRole: string, currentUserId: string): Promise<StudentGuidanceRecord[]> {
    if (isSupabaseAvailable()) {
      try {
        let query = supabase
          .from('student_guidance_records')
          .select('*, student:students(*), recorder:profiles(*)')
          .order('guidance_date', { ascending: false });

        // Enforce RLS restriction: regular teachers only see their own recorded records
        if (userRole !== 'admin' && userRole !== 'kepala_madrasah') {
          let recorderId = isUuid(currentUserId) ? currentUserId : '';
          if (!recorderId) {
            const { data: sessionData } = await supabase.auth.getSession();
            if (isUuid(sessionData?.session?.user?.id)) recorderId = sessionData!.session!.user!.id;
          }
          if (recorderId) {
            query = query.eq('recorded_by', recorderId);
          }
        }

        const { data, error } = await query;
        reportSupabaseOutcome(error);
        if (!error && data && data.length > 0) return data as StudentGuidanceRecord[];
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase getGuidanceRecords fallback:', err);
      }
    }

    let records = getLocal<StudentGuidanceRecord[]>(STORAGE_KEY, DEMO_GUIDANCES);
    if (userRole !== 'admin' && userRole !== 'kepala_madrasah') {
      records = records.filter((r) => r.recorded_by === currentUserId);
    }

    return records.map((r) => ({
      ...r,
      student: r.student || DEMO_STUDENTS.find((s) => s.id === r.student_id),
    }));
  },

  async createGuidanceRecord(
    payload: Omit<StudentGuidanceRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<StudentGuidanceRecord> {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `gd-${Date.now()}`;
    let newRecord: StudentGuidanceRecord = {
      ...payload,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      student: DEMO_STUDENTS.find((s) => s.id === payload.student_id),
    };

    if (isSupabaseAvailable() && isUuid(id) && isUuid(payload.student_id)) {
      try {
        let recordedBy = isUuid(payload.recorded_by) ? payload.recorded_by : '';
        if (!recordedBy) {
          const { data: sessionData } = await supabase.auth.getSession();
          if (isUuid(sessionData?.session?.user?.id)) recordedBy = sessionData!.session!.user!.id;
        }
        if (isUuid(recordedBy)) {
          const { student: _s, recorder: _r, ...dbPayload } = { ...newRecord, recorded_by: recordedBy };
          const { data, error } = await supabase.from('student_guidance_records').insert(dbPayload).select().single();
          reportSupabaseOutcome(error);
          if (!error && data) {
            newRecord = { ...(data as StudentGuidanceRecord), student: newRecord.student };
          }
        }
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase createGuidanceRecord fallback:', err);
      }
    }

    const current = getLocal<StudentGuidanceRecord[]>(STORAGE_KEY, DEMO_GUIDANCES);
    const updated = [newRecord, ...current.filter((r) => r.id !== newRecord.id)];
    setLocal(STORAGE_KEY, updated);
    return newRecord;
  },

  async updateGuidanceStatus(id: string, status: GuidanceStatus): Promise<StudentGuidanceRecord> {
    const records = getLocal<StudentGuidanceRecord[]>(STORAGE_KEY, DEMO_GUIDANCES);
    const item = records.find((r) => r.id === id);
    if (!item) throw new Error('Data bimbingan tidak ditemukan');

    const updatedItem: StudentGuidanceRecord = {
      ...item,
      status,
      updated_at: new Date().toISOString(),
    };

    if (isSupabaseAvailable() && isUuid(id)) {
      try {
        const { error } = await supabase.from('student_guidance_records').update({ status }).eq('id', id);
        reportSupabaseOutcome(error);
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase updateGuidanceStatus fallback:', err);
      }
    }

    const updatedList = records.map((r) => (r.id === id ? updatedItem : r));
    setLocal(STORAGE_KEY, updatedList);
    return updatedItem;
  },
};
