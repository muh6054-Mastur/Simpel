import { supabase, isSupabaseAvailable, reportSupabaseOutcome } from '../lib/supabaseClient';
import { TeachingJournal } from '../types/database.types';
import { DEMO_JOURNALS } from '../lib/demoData';
import { academicService } from './academicService';

const STORAGE_KEY = 'simpel_teaching_journals';
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

export const journalService = {
  async getJournals(filters?: { assignmentId?: string; date?: string; teacherId?: string }): Promise<TeachingJournal[]> {
    let baseJournals = getLocal<TeachingJournal[]>(STORAGE_KEY, DEMO_JOURNALS);

    if (isSupabaseAvailable()) {
      try {
        const { data, error } = await supabase
          .from('teaching_journals')
          .select('*, assignment:teaching_assignments(*, teacher:teachers(*), class:classes(*), subject:subjects(*))')
          .order('date', { ascending: false });

        reportSupabaseOutcome(error);
        if (!error && Array.isArray(data) && data.length > 0) {
          const mapById = new Map<string, TeachingJournal>();
          for (const item of baseJournals) {
            mapById.set(item.id, item);
          }
          for (const remoteItem of data as TeachingJournal[]) {
            const existing = mapById.get(remoteItem.id);
            if (!existing) {
              mapById.set(remoteItem.id, remoteItem);
            } else {
              const remoteTs = Date.parse(remoteItem.updated_at || remoteItem.created_at || '') || 0;
              const localTs = Date.parse(existing.updated_at || existing.created_at || '') || 0;
              if (remoteTs >= localTs) {
                mapById.set(remoteItem.id, remoteItem);
              }
            }
          }
          baseJournals = Array.from(mapById.values());
        }
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase getJournals fallback:', err);
      }
    }

    const assignments = await academicService.getTeachingAssignments();
    let hydrated = baseJournals.map((j) => {
      const matched =
        assignments.find((a) => a.id === j.assignment_id) ||
        (j.assignment?.class_id && j.assignment?.subject_id
          ? assignments.find(
              (a) =>
                a.class_id === j.assignment?.class_id &&
                a.subject_id === j.assignment?.subject_id
            )
          : undefined);
      return {
        ...j,
        assignment_id: matched?.id || j.assignment_id,
        assignment: matched || j.assignment,
      };
    });

    if (filters?.assignmentId) hydrated = hydrated.filter((j) => j.assignment_id === filters.assignmentId);
    if (filters?.date) hydrated = hydrated.filter((j) => j.date === filters.date);
    if (filters?.teacherId) {
      hydrated = hydrated.filter((j) => j.assignment?.teacher_id === filters.teacherId);
    }

    return hydrated.sort((a, b) => {
      const dateDiff = (b.date || '').localeCompare(a.date || '');
      if (dateDiff !== 0) return dateDiff;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  },

  async createJournal(payload: Omit<TeachingJournal, 'id' | 'created_at' | 'updated_at'>): Promise<TeachingJournal> {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `jrn-${Date.now()}`;
    const assignments = await academicService.getTeachingAssignments();
    const matchedAssignment = assignments.find((a) => a.id === payload.assignment_id);
    const now = new Date().toISOString();

    let newJournal: TeachingJournal = {
      ...payload,
      id,
      assignment: matchedAssignment,
      created_at: now,
      updated_at: now,
    };

    const current = getLocal<TeachingJournal[]>(STORAGE_KEY, DEMO_JOURNALS);
    const updatedLocalFirst = [newJournal, ...current.filter((j) => j.id !== newJournal.id)];
    setLocal(STORAGE_KEY, updatedLocalFirst);

    if (isSupabaseAvailable() && isUuid(id) && isUuid(payload.assignment_id)) {
      try {
        const { assignment: _a, ...dbPayload } = newJournal;
        const { data, error } = await supabase
          .from('teaching_journals')
          .insert(dbPayload)
          .select()
          .maybeSingle();
        reportSupabaseOutcome(error);
        if (!error && data) {
          newJournal = { ...(data as TeachingJournal), assignment: matchedAssignment };
          const latest = getLocal<TeachingJournal[]>(STORAGE_KEY, updatedLocalFirst);
          setLocal(STORAGE_KEY, [newJournal, ...latest.filter((j) => j.id !== newJournal.id)]);
        } else if (error) {
          console.warn('Supabase createJournal warning (tersimpan lokal & sync):', error.message);
        }
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase createJournal fallback:', err);
      }
    }

    return newJournal;
  },

  async updateJournal(id: string, updates: Partial<TeachingJournal>): Promise<TeachingJournal> {
    const journals = await this.getJournals();
    const existing = journals.find((j) => j.id === id);
    if (!existing) throw new Error('Jurnal tidak ditemukan');

    const updatedJournal: TeachingJournal = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    if (isSupabaseAvailable() && isUuid(id)) {
      try {
        const { assignment: _a, ...dbUpdates } = updates;
        const { error } = await supabase.from('teaching_journals').update(dbUpdates).eq('id', id);
        reportSupabaseOutcome(error);
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase updateJournal fallback:', err);
      }
    }

    const current = getLocal<TeachingJournal[]>(STORAGE_KEY, DEMO_JOURNALS);
    const updated = current.some((j) => j.id === id)
      ? current.map((j) => (j.id === id ? updatedJournal : j))
      : [updatedJournal, ...current];
    setLocal(STORAGE_KEY, updated);
    return updatedJournal;
  },

  async deleteJournal(id: string): Promise<void> {
    if (isSupabaseAvailable() && isUuid(id)) {
      try {
        const { error } = await supabase.from('teaching_journals').delete().eq('id', id);
        reportSupabaseOutcome(error);
      } catch (err) {
        reportSupabaseOutcome(err);
        console.warn('Supabase deleteJournal fallback:', err);
      }
    }
    const current = getLocal<TeachingJournal[]>(STORAGE_KEY, DEMO_JOURNALS);
    setLocal(STORAGE_KEY, current.filter((j) => j.id !== id));
  },
};

