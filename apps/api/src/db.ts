import { MongoClient, type ClientSession } from 'mongodb';
import type { Change, Device, Playlist, Track } from '@resonant/types';
import type { Config } from './config.js';
type Doc<T> = T & { _id: string };
export type StoredTrack = Track & { key: string; artworkKey?: string; artworkBytes?: number };
export type Job = {
  _id: string; filename: string; size: number; hash: string; mime: string;
  state: 'reserved'|'verifying'|'complete'|'cancelled'|'failed';
  expires: Date; created: Date; multipart?: string; owner?: string; error?: string; cleaned?: boolean; artworkBytes?: number;
};
export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export async function database(config: Config) {
  const client = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 12 });
  await client.connect();
  const db = client.db(config.MONGO_DB);
  const tracks = db.collection<Doc<StoredTrack>>('tracks');
  const playlists = db.collection<Doc<Playlist>>('playlists');
  const changes = db.collection<Change & { _id: string }>('changes');
  const state = db.collection<{ _id: string; revision: number; used: number; reserved: number }>('library_state');
  const jobs = db.collection<Job>('import_jobs');
  const devices = db.collection<Doc<Device> & { token: string; expiry: Date }>('devices');
  const grants = db.collection<{ _id: string; expiry: Date; name: string }>('auth_grants');
  const operations = db.collection<{ _id: string; expires: Date }>('applied_operations');
  const garbage = db.collection<{ _id: string; keys: string[]; bytes: number; after?: Date }>('garbage');
  const history = db.collection<{ _id: string; trackId: string; at: Date }>('playback_history');
  await Promise.all([
    tracks.createIndex({hash:1},{unique:true}), tracks.createIndex({createdAt:-1,_id:-1}), tracks.createIndex({title:1,_id:1}),
    tracks.createIndex({artist:1}), tracks.createIndex({album:1}), tracks.createIndex({filename:1}),
    tracks.createIndex({lastPlayed:-1}), tracks.createIndex({size:-1}), playlists.createIndex({trackIds:1}),
    changes.createIndex({revision:1},{unique:true}), jobs.createIndex({state:1,expires:1}), devices.createIndex({token:1},{unique:true}),
    grants.createIndex({expiry:1},{expireAfterSeconds:0}), operations.createIndex({expires:1},{expireAfterSeconds:0}),
    history.createIndex({at:1},{expireAfterSeconds:31536000}), history.createIndex({trackId:1,at:-1}),
  ]);
  await state.updateOne({_id:'library'},{$setOnInsert:{revision:0,used:0,reserved:0}},{upsert:true});
  const tx = <T>(fn:(session:ClientSession)=>Promise<T>) => client.withSession(session => session.withTransaction(() => fn(session)));
  const publish = async (change: Omit<Change,'revision'>, session:ClientSession) => {
    const updated = await state.findOneAndUpdate({_id:'library'},{$inc:{revision:1}},{returnDocument:'after',session});
    const key=change.kind+":"+change.id;
    await changes.replaceOne({_id:key},{...change,_id:key,revision:updated!.revision} as Change & {_id:string},{session,upsert:true});
  };
  return {client,db,tracks,playlists,changes,state,jobs,devices,grants,operations,garbage,history,tx,publish};
}
export type Database = Awaited<ReturnType<typeof database>>;
export function publicTrack({ key: _key, artworkKey: _artworkKey, artworkBytes: _artworkBytes, ...track }: StoredTrack & {_id?:string}): Track {
  delete track._id;
  return track;
}
