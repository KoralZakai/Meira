import { CATEGORY_META } from './theme';
import { CustomCategory, loadCustomCategories, saveCustomCategory } from '../services/TaskStorage';

export interface CategoryMeta {
  color: string;
  icon: string;
  labelEn: string;
  labelHe: string;
}

export interface CategoryEntry extends CategoryMeta {
  key: string;
  custom: boolean;
}

// Synchronous cache of user-created categories, hydrated from storage at startup
// and refreshed whenever a new custom category is added.
let customCache: Record<string, CategoryMeta> = {};

// Palette used to auto-assign a colour to brand-new custom categories.
const CUSTOM_PALETTE = ['#9B5DE5', '#4361EE', '#F77F00', '#118AB2', '#06D6A0', '#FF85A1', '#2D8CFF', '#FF9F1C'];

export async function hydrateCustomCategories(): Promise<void> {
  const list = await loadCustomCategories();
  customCache = Object.fromEntries(
    list.map((c) => [c.key, { color: c.color, icon: c.icon, labelEn: c.labelEn, labelHe: c.labelHe }]),
  );
}

export function getCategoryMeta(category?: string): CategoryMeta {
  if (!category) return CATEGORY_META.general;
  return CATEGORY_META[category] || customCache[category] || CATEGORY_META.general;
}

export function allCategories(): CategoryEntry[] {
  const builtIn: CategoryEntry[] = Object.entries(CATEGORY_META).map(([key, meta]) => ({
    key,
    ...meta,
    custom: false,
  }));
  const custom: CategoryEntry[] = Object.entries(customCache).map(([key, meta]) => ({
    key,
    ...meta,
    custom: true,
  }));
  return [...builtIn, ...custom];
}

// Create + persist a new custom category from a display name. Returns its key.
export async function createCustomCategory(name: string, icon = '🏷️'): Promise<string> {
  const trimmed = name.trim();
  const key = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `custom_${Date.now()}`;

  const existingCount = Object.keys(customCache).length;
  const category: CustomCategory = {
    key,
    icon,
    color: CUSTOM_PALETTE[existingCount % CUSTOM_PALETTE.length],
    labelEn: trimmed,
    labelHe: trimmed,
  };

  await saveCustomCategory(category);
  customCache[key] = { color: category.color, icon: category.icon, labelEn: trimmed, labelHe: trimmed };
  return key;
}
