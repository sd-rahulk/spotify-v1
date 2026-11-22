import { z } from 'zod';
const label = z.string().trim().max(240);
export const id = z.uuid();
export const trackPatch = z.object({
  title: label.min(1), artist: label, album: label, albumArtist: label, genre: label,
  trackNumber: z.number().int().min(0).max(99999), discNumber: z.number().int().min(0).max(99999),
  lyrics: z.string().max(64000), liked: z.boolean(),
}).partial().strict();
export const playlistPatch = z.object({
  name: label.min(1), trackIds: z.array(id).max(3000), coverTrackId: id.nullable(),
}).partial().strict();
export const uploadBatch = z.object({ files: z.array(z.object({
  filename: z.string().min(1).max(240).refine(v => !/[\\/\u0000-\u001f]/u.test(v) && v !== '.' && v !== '..'),
  size: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/),
})).min(1).max(100) });
export const syncWrites = z.object({ operations: z.array(z.discriminatedUnion('kind', [
  z.object({ operationId: id, kind: z.literal('like'), id, liked: z.boolean() }),
  z.object({ operationId: id, kind: z.literal('play'), id, at: z.iso.datetime() }),
  z.object({ operationId: id, kind: z.literal('playlist'), id, patch: playlistPatch.nullable() }),
])).min(1).max(50) });
