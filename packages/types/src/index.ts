export interface Track {
  id: string; title: string; artist: string; album: string; albumArtist: string; genre: string;
  duration: number; trackNumber: number; discNumber: number; bitrate: number; codec: string;
  filename: string; size: number; mime: string; hash: string; lyrics: string;
  artwork?: string; liked: boolean; playCount: number; lastPlayed?: string;
  createdAt: string; updatedAt: string;
}
export interface Playlist { id: string; name: string; trackIds: string[]; artwork?: string; coverTrackId?: string; updatedAt: string }
export type Change = { revision: number; kind: 'track'; id: string; value: Track | null }
  | { revision: number; kind: 'playlist'; id: string; value: Playlist | null };
export interface Page<T> { items: T[]; next: string | null }
export interface Group { id: string; name: string; artist: string; count: number; duration: number; artwork?: string }
export interface UploadFile { filename: string; size: number; hash: string }
export interface UploadPlan {
  id: string; duplicate?: boolean; partSize: number; parts: { number: number; url: string }[];
}
export interface Usage { used: number; reserved: number; quota: number; tracks: number; albums: number; artists: number; playlists: number; formats: Record<string,number> }
export interface Device { id: string; name: string; createdAt: string; expiresAt: string }
