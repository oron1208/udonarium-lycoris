export interface StatusMarkerDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export const STATUS_MARKER_DICTIONARY: StatusMarkerDefinition[] = [
  { id: 'poison', name: '毒', icon: '☠️', color: '#5eb45e' },
  { id: 'sleep', name: '睡眠', icon: '💤', color: '#5577cc' },
  { id: 'stun', name: '気絶', icon: '💫', color: '#d6b84a' },
  { id: 'burn', name: '炎上', icon: '🔥', color: '#e06633' },
  { id: 'fear', name: '恐怖', icon: '😱', color: '#8b5fd6' },
  { id: 'charm', name: '魅了', icon: '🩷', color: '#ff8ac8' },
  { id: 'hidden', name: '隠密', icon: '👁️‍🗨️', color: '#666666' },
  { id: 'concentrate', name: '集中', icon: '✨', color: '#4aa3df' },
  { id: 'down', name: '転倒', icon: '⬇️', color: '#8a6d3b' },
  { id: 'bind', name: '拘束', icon: '⛓️', color: '#777777' },
  { id: 'bless', name: '祝福', icon: '🛡️', color: '#66bbaa' }
];

export function getStatusMarkerDefinition(id: string): StatusMarkerDefinition {
  return STATUS_MARKER_DICTIONARY.find(marker => marker.id === id) || null;
}

export function parseCustomStatusMarkerDictionary(customDictionary: string): StatusMarkerDefinition[] {
  try {
    const values = JSON.parse(customDictionary || '[]');
    if (!Array.isArray(values)) return [];
    return values
      .filter(value => value && value.id && value.name && value.icon)
      .map(value => ({
        id: String(value.id),
        name: String(value.name),
        icon: String(value.icon),
        color: String(value.color || '#777777')
      }));
  } catch (e) {
    return [];
  }
}

export function mergeStatusMarkerDictionary(customDictionary: string): StatusMarkerDefinition[] {
  const merged = new Map<string, StatusMarkerDefinition>();
  for (const marker of STATUS_MARKER_DICTIONARY) merged.set(marker.id, marker);
  for (const marker of parseCustomStatusMarkerDictionary(customDictionary)) merged.set(marker.id, marker);
  return Array.from(merged.values());
}

export function findStatusMarkerDefinition(id: string, customDictionary: string = '[]'): StatusMarkerDefinition {
  return mergeStatusMarkerDictionary(customDictionary).find(marker => marker.id === id) || null;
}

export function parseStatusMarkerIds(value: any): string[] {
  if (Array.isArray(value)) return value.map(id => String(id)).filter(id => 0 < id.length);
  if (value == null || value === '') return [];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(id => String(id)).filter(id => 0 < id.length);
  } catch (e) {
    // 古い一時実装でカンマ区切りになった値も拾う
  }
  return value.split(',').map(id => id.trim()).filter(id => 0 < id.length);
}

export function stringifyStatusMarkerIds(ids: string[]): string {
  const uniqueIds = Array.from(new Set((ids || []).map(id => String(id)).filter(id => 0 < id.length)));
  return JSON.stringify(uniqueIds);
}
