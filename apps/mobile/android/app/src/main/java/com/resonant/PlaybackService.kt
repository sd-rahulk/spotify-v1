package com.resonant

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

internal fun mediaItem(value:JSONObject):MediaItem {
    val id=value.getString("id")
    val metadata=MediaMetadata.Builder().setTitle(value.optString("title")).setArtist(value.optString("artist"))
        .setAlbumTitle(value.optString("album"))
    value.optString("nativeArtwork").takeIf { it.startsWith("https://") || it.startsWith("file:") || (BuildConfig.DEBUG && it.startsWith("http://")) }
        ?.let { metadata.setArtworkUri(Uri.parse(it)) }
    return MediaItem.Builder().setMediaId(id).setUri("resonant://track/"+id).setCustomCacheKey(id)
        .setMimeType(value.optString("mime").ifBlank { null }).setMediaMetadata(metadata.build()).build()
}

@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession?=null
    private lateinit var player: ExoPlayer
    private lateinit var cache: SimpleCache
    private lateinit var db: LibraryDb
    private val jobs=Executors.newSingleThreadExecutor()
    private val handler=Handler(Looper.getMainLooper())
    private var counted:String?=null
    private val checkpoint=object: Runnable {
        override fun run() { if(player.isPlaying) persist(); handler.postDelayed(this,10000) }
    }

    override fun onCreate() {
        super.onCreate()
        db=LibraryDb.get(this)
        val cap=(db.state("cacheMb")?.toLongOrNull() ?: 192).coerceIn(32,1024)*1024*1024
        cache=SimpleCache(File(cacheDir,"stream"),LeastRecentlyUsedCacheEvictor(cap),StandaloneDatabaseProvider(this))
        val network=DefaultHttpDataSource.Factory().setUserAgent("Resonant Android").setConnectTimeoutMs(8000).setReadTimeoutMs(12000)
        val upstream=ResolvingDataSource.Factory(DefaultDataSource.Factory(this,network)) { spec ->
            val id=spec.uri.lastPathSegment ?: throw java.io.IOException("Track ID missing")
            val file=db.offline(this,id)
            if(file!=null) spec.withUri(Uri.fromFile(file)) else spec.withUri(Uri.parse(Credentials.url(this,id).getString("url")))
        }
        val cached=CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        // The offline branch goes straight through a file source and never fills the streaming cache.
        val sourceFactory=androidx.media3.datasource.DataSource.Factory {
            object: androidx.media3.datasource.DataSource {
                private var delegate:androidx.media3.datasource.DataSource?=null
                private val listeners=mutableListOf<androidx.media3.datasource.TransferListener>()
                override fun addTransferListener(listener:androidx.media3.datasource.TransferListener) {
                    listeners.add(listener);delegate?.addTransferListener(listener)
                }
                override fun open(spec:androidx.media3.datasource.DataSpec):Long {
                    val file=spec.uri.lastPathSegment?.let { db.offline(this@PlaybackService,it) }
                    val selected=if(file!=null) androidx.media3.datasource.FileDataSource() else cached.createDataSource()
                    delegate=selected
                    listeners.forEach { selected.addTransferListener(it) }
                    return selected.open(if(file!=null) spec.withUri(Uri.fromFile(file)) else spec)
                }
                override fun getUri():Uri?=delegate?.uri
                override fun getResponseHeaders():Map<String,List<String>> = delegate?.responseHeaders ?: emptyMap()
                override fun read(buffer:ByteArray,offset:Int,length:Int):Int=delegate!!.read(buffer,offset,length)
                override fun close(){ val value=delegate;delegate=null;value?.close() }
            }
        }
        player=ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(sourceFactory))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build()
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        session=MediaSession.Builder(this,player).setSessionActivity(open).setCallback(object:MediaSession.Callback {
            override fun onConnect(session:MediaSession, controller:MediaSession.ControllerInfo):MediaSession.ConnectionResult {
                if(controller.uid==applicationInfo.uid) return super.onConnect(session,controller)
                val transport=MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                    .remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).remove(Player.COMMAND_SET_MEDIA_ITEM).build()
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailablePlayerCommands(transport).build()
            }
        }).build()
        restore()
        player.addListener(object:Player.Listener {
            override fun onEvents(player:Player,events:Player.Events) {
                if(events.containsAny(Player.EVENT_TIMELINE_CHANGED,Player.EVENT_MEDIA_ITEM_TRANSITION,Player.EVENT_IS_PLAYING_CHANGED,
                        Player.EVENT_POSITION_DISCONTINUITY,Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,Player.EVENT_REPEAT_MODE_CHANGED)) persist()
                val id=player.currentMediaItem?.mediaId
                if(id!=null&&events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) artwork(id)
                if(id!=counted && player.isPlaying && id!=null) {
                    counted=id
                    jobs.execute {
                        if(db.track(id)?.optBoolean("local")==false)
                            db.enqueue(JSONObject().put("operationId",UUID.randomUUID().toString()).put("kind","play").put("id",id)
                                .put("at",java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US).apply {
                                    timeZone=java.util.TimeZone.getTimeZone("UTC")
                                }.format(java.util.Date())))
                    }
                }
            }
        })
        player.currentMediaItem?.mediaId?.let { artwork(it) }
        handler.postDelayed(checkpoint,10000)
    }
    private fun artwork(id:String) {
        jobs.execute {
            val row=db.track(id) ?: return@execute
            if(!row.has("artwork"))return@execute
            val uri=runCatching { Credentials.url(this,id).optString("artwork") }.getOrNull().orEmpty()
            if(uri.isBlank())return@execute
            handler.post {
                if(session==null||player.currentMediaItem?.mediaId!=id)return@post
                val item=player.currentMediaItem ?: return@post
                if(item.mediaMetadata.artworkUri==null) {
                    player.replaceMediaItem(player.currentMediaItemIndex,item.buildUpon()
                        .setMediaMetadata(item.mediaMetadata.buildUpon().setArtworkUri(Uri.parse(uri)).build()).build())
                }
            }
        }
    }
    private fun persist() {
        val ids=JSONArray()
        for(i in 0 until player.mediaItemCount) ids.put(player.getMediaItemAt(i).mediaId)
        val state=JSONObject().put("ids",ids).put("index",player.currentMediaItemIndex)
            .put("position",player.currentPosition).put("shuffle",player.shuffleModeEnabled).put("repeat",player.repeatMode).toString()
        jobs.execute { db.save("queue",state) }
    }
    private fun restore() {
        val state=db.state("queue")?.let { JSONObject(it) } ?: return
        val ids=state.optJSONArray("ids") ?: return
        val all=(0 until ids.length()).mapNotNull { i -> db.track(ids.getString(i))?.let { i to mediaItem(it) } }
        if(all.isEmpty()) return
        val index=all.indexOfFirst { it.first==state.optInt("index") }.coerceAtLeast(0)
        val item=all[index]
        val duration=((db.track(item.second.mediaId)?.optDouble("duration",0.0) ?: 0.0)*1000).toLong()
        val checkpoint=state.optLong("position").coerceAtLeast(0)
        val position=if(item.first!=state.optInt("index") || (duration>0 && checkpoint>=duration-250)) 0L else checkpoint
        player.setMediaItems(all.map { it.second },index,position)
        player.shuffleModeEnabled=state.optBoolean("shuffle")
        player.repeatMode=state.optInt("repeat").coerceIn(0,2)
    }
    override fun onGetSession(controllerInfo:MediaSession.ControllerInfo):MediaSession?=session

    override fun onDestroy() {
        handler.removeCallbacks(checkpoint)
        persist()
        session?.release()
        session=null
        player.release()
        cache.release()
        jobs.shutdown()
        super.onDestroy()
    }
}
