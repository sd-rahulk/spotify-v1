package com.resonant

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal class LibraryDb private constructor(context: Context) : SQLiteOpenHelper(context, "library.db", null, 2) {
    companion object {
        @Volatile private var instance: LibraryDb? = null
        fun get(context: Context): LibraryDb = instance ?: synchronized(this) {
            instance ?: LibraryDb(context.applicationContext).also { instance = it }
        }
    }
    override fun onConfigure(db: SQLiteDatabase) { db.enableWriteAheadLogging() }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE tracks(id TEXT PRIMARY KEY, data TEXT NOT NULL, local INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, created TEXT NOT NULL)")
        db.execSQL("CREATE TABLE playlists(id TEXT PRIMARY KEY, data TEXT NOT NULL, name TEXT NOT NULL)")
        db.execSQL("CREATE VIRTUAL TABLE search USING fts4(id, words, tokenize=unicode61)")
        db.execSQL("CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL("CREATE TABLE pending(seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, op TEXT NOT NULL)")
        db.execSQL("CREATE TABLE downloads(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        queryIndexes(db)
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if(oldVersion<2) {
            db.execSQL("ALTER TABLE tracks ADD COLUMN title TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE tracks ADD COLUMN created TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE playlists ADD COLUMN name TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE pending ADD COLUMN op TEXT NOT NULL DEFAULT ''")
            db.rawQuery("SELECT id,data FROM tracks",null).use { c ->
                while(c.moveToNext()) {
                    val value=JSONObject(c.getString(1))
                    db.execSQL("UPDATE tracks SET title=?,created=? WHERE id=?",arrayOf(value.optString("title"),value.optString("createdAt"),c.getString(0)))
                }
            }
            db.rawQuery("SELECT id,data FROM playlists",null).use { c ->
                while(c.moveToNext()) db.execSQL("UPDATE playlists SET name=? WHERE id=?",arrayOf(JSONObject(c.getString(1)).optString("name"),c.getString(0)))
            }
            db.rawQuery("SELECT seq,data FROM pending",null).use { c ->
                while(c.moveToNext()) db.execSQL("UPDATE pending SET op=? WHERE seq=?",arrayOf(JSONObject(c.getString(1)).optString("operationId"),c.getLong(0)))
            }
            queryIndexes(db)
        }
    }
    private fun queryIndexes(db:SQLiteDatabase) {
        db.execSQL("CREATE INDEX tracks_by_date ON tracks(created DESC,id)")
        db.execSQL("CREATE INDEX pending_operation ON pending(op)")
    }

    fun state(key: String): String? = readableDatabase.rawQuery("SELECT value FROM state WHERE key=?", arrayOf(key)).use {
        if (it.moveToFirst()) it.getString(0) else null
    }
    fun save(key: String, value: String) {
        writableDatabase.execSQL("INSERT OR REPLACE INTO state VALUES (?,?)", arrayOf(key,value))
    }
    private fun rows(sql: String, args: Array<String> = emptyArray()): JSONArray {
        val array = JSONArray()
        readableDatabase.rawQuery(sql,args).use { c -> while(c.moveToNext()) array.put(JSONObject(c.getString(0))) }
        return array
    }
    fun tracks(search: String, limit: Int, offset: Int): JSONArray {
        val parts = Regex("[\\p{L}\\p{N}\\p{M}]+").findAll(search.take(180)).map { it.value + "*" }.take(10).toList()
        if (parts.isEmpty()) return rows("SELECT data FROM tracks ORDER BY created DESC,id LIMIT ? OFFSET ?", arrayOf(limit.toString(),offset.toString()))
        val phrase = parts.joinToString(" ")
        return rows("""SELECT data FROM tracks WHERE id IN (SELECT id FROM search WHERE words MATCH ?)
            OR instr(lower(title),lower(?))>0
            ORDER BY title,id LIMIT ? OFFSET ?""", arrayOf(phrase,search,limit.toString(),offset.toString()))
    }
    fun track(id: String): JSONObject? = rows("SELECT data FROM tracks WHERE id=?",arrayOf(id)).optJSONObject(0)
    fun playlists() = rows("SELECT data FROM playlists ORDER BY name")
    fun downloads() = rows("SELECT data FROM downloads")
    fun download(id: String): JSONObject? = rows("SELECT data FROM downloads WHERE id=?",arrayOf(id)).optJSONObject(0)
    fun pending() = rows("SELECT data FROM pending ORDER BY seq LIMIT 50")
    fun writeDownload(id: String, json: JSONObject) {
        writableDatabase.execSQL("INSERT OR REPLACE INTO downloads VALUES (?,?)",arrayOf(id,json.toString()))
    }
    fun deleteDownload(id:String) { writableDatabase.execSQL("DELETE FROM downloads WHERE id=?",arrayOf(id)) }
    fun writeTrack(value: JSONObject, local: Boolean = false) {
        val id = value.getString("id")
        writableDatabase.execSQL("INSERT OR REPLACE INTO tracks(id,data,local,title,created) VALUES (?,?,?,?,?)", arrayOf(id,value.toString(),if(local)1 else 0,value.optString("title"),value.optString("createdAt")))
        writableDatabase.execSQL("DELETE FROM search WHERE id=?", arrayOf(id))
        val words = listOf("title","artist","album","albumArtist","genre","filename").joinToString(" ") { value.optString(it) }
        writableDatabase.execSQL("INSERT INTO search VALUES (?,?)", arrayOf(id,words))
    }
    private fun playlist(id: String, value: JSONObject?) {
        if (value==null) writableDatabase.execSQL("DELETE FROM playlists WHERE id=?",arrayOf(id))
        else writableDatabase.execSQL("INSERT OR REPLACE INTO playlists(id,data,name) VALUES (?,?,?)",arrayOf(id,value.toString(),value.optString("name")))
    }
    fun enqueue(operation: JSONObject) {
        val db=writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("INSERT INTO pending(data,op) VALUES (?,?)",arrayOf(operation.toString(),operation.getString("operationId")))
            optimistic(operation)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    private fun optimistic(op:JSONObject) {
        val id=op.getString("id")
        when(op.getString("kind")) {
            "like" -> track(id)?.let { it.put("liked",op.getBoolean("liked")); writeTrack(it,it.optBoolean("local")) }
            "playlist" -> {
                val patch=op.optJSONObject("patch")
                if (patch==null) playlist(id,null)
                else {
                    val value=rows("SELECT data FROM playlists WHERE id=?",arrayOf(id)).optJSONObject(0)
                        ?: JSONObject().put("id",id).put("name","New playlist").put("trackIds",JSONArray())
                    for (key in patch.keys()) value.put(key,patch.get(key))
                    playlist(id,value)
                }
            }
        }
    }
    fun confirm(ids: JSONArray) {
        for(i in 0 until ids.length()) writableDatabase.execSQL("DELETE FROM pending WHERE op=?",arrayOf(ids.getString(i)))
    }
    fun apply(envelope: JSONObject): List<String> {
        val removed = mutableListOf<String>()
        val db=writableDatabase
        db.beginTransaction()
        try {
            val changes=envelope.getJSONArray("items")
            for(i in 0 until changes.length()) {
                val change=changes.getJSONObject(i)
                val id=change.getString("id")
                val value=change.optJSONObject("value")
                if(change.getString("kind")=="playlist") playlist(id,value)
                else if(value!=null) writeTrack(value)
                else {
                    db.execSQL("DELETE FROM tracks WHERE id=? AND local=0",arrayOf(id))
                    db.execSQL("DELETE FROM search WHERE id=?",arrayOf(id))
                    removed.add(id)
                }
            }
            val outstanding=rows("SELECT data FROM pending ORDER BY seq")
            for(i in 0 until outstanding.length()) optimistic(outstanding.getJSONObject(i))
            save("cursor",envelope.getLong("cursor").toString())
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return removed
    }
    fun explicitPath(context: Context,id: String): File = File(File(context.filesDir,"audio").apply { mkdirs() },id)
    fun offline(context: Context,id: String): File? {
        val metadata=track(id) ?: return null
        val file=explicitPath(context,id)
        val accepted=metadata.optBoolean("local") || download(id)?.optString("state")=="Complete"
        return file.takeIf { accepted && it.isFile && it.length()==metadata.optLong("size") }
    }
}
