import { KoKurikulerItem, KoKurikulerSubMenu } from '../types/kokurikuler.types';

const STORAGE_KEY = 'simpel_mi_kokurikuler_items_v1';

function getStored(): KoKurikulerItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setStored(items: KoKurikulerItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error('Gagal menyimpan data Ko Kurikuler:', err);
  }
}

export const kokurikulerService = {
  getAll(): KoKurikulerItem[] {
    return getStored().sort((a, b) =>
      (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '')
    );
  },

  getByTeacherScope(matchingTeacherIds: string[]): KoKurikulerItem[] {
    const all = this.getAll();
    if (!matchingTeacherIds || matchingTeacherIds.length === 0) return all;
    const idSet = new Set(matchingTeacherIds);
    return all.filter((item) => !item.teacher_id || idSet.has(item.teacher_id));
  },

  getBySubMenu(
    subMenu: KoKurikulerSubMenu,
    matchingTeacherIds?: string[]
  ): KoKurikulerItem[] {
    const scoped =
      matchingTeacherIds && matchingTeacherIds.length > 0
        ? this.getByTeacherScope(matchingTeacherIds)
        : this.getAll();
    return scoped.filter((item) => item.sub_menu === subMenu);
  },

  getCountsBySubMenu(matchingTeacherIds?: string[]): Record<KoKurikulerSubMenu, number> {
    const scoped =
      matchingTeacherIds && matchingTeacherIds.length > 0
        ? this.getByTeacherScope(matchingTeacherIds)
        : this.getAll();
    const counts: Record<KoKurikulerSubMenu, number> = {
      perencanaan: 0,
      'bahan-ajar': 0,
      asesmen: 0,
      administrasi: 0,
    };
    for (const item of scoped) {
      if (item.sub_menu in counts) {
        counts[item.sub_menu] += 1;
      }
    }
    return counts;
  },

  saveItem(
    payload: Omit<KoKurikulerItem, 'id' | 'created_at' | 'updated_at'> & {
      id?: string;
      created_at?: string;
    }
  ): KoKurikulerItem {
    const list = getStored();
    const now = new Date().toISOString();
    const existing = payload.id ? list.find((item) => item.id === payload.id) : undefined;

    const saved: KoKurikulerItem = {
      ...payload,
      id: payload.id || `kk-${payload.sub_menu}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      created_at: existing?.created_at || payload.created_at || now,
      updated_at: now,
    };

    const next = existing
      ? list.map((item) => (item.id === saved.id ? saved : item))
      : [saved, ...list];
    setStored(next);
    return saved;
  },

  deleteItem(id: string): void {
    const next = getStored().filter((item) => item.id !== id);
    setStored(next);
  },
};
