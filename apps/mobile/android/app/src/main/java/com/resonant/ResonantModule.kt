package com.resonant

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class ResonantPackage:ReactPackage {
    override fun createNativeModules(context:ReactApplicationContext):List<NativeModule> = listOf(ResonantModule(context))
    override fun createViewManagers(context:ReactApplicationContext):List<ViewManager<*,*>> = emptyList()
}

@OptIn(UnstableApi::class)
class ResonantModule(private val context:ReactApplicationContext):ReactContextBaseJavaModule(context) {
    override fun getName()="ResonantNative"
    override fun getConstants():Map<String,Any> = mapOf("debugBuild" to BuildConfig.DEBUG)
    private val db=LibraryDb.get(context)
    private val work by lazy { WorkManager.getInstance(context) }
    private val io=Executors.newSingleThreadExecutor()
    private val main=Handler(Looper.getMainLooper())
    private var controller:MediaController?=null
    private var connection:com.google.common.util.concurrent.ListenableFuture<MediaController>?=null
    private val audio=context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var importPromise:Promise?=null
    private var observing=false
    private val tick=object:Runnable {
        override fun run() {
            if(!observing)return
            controller?.let { player ->
                context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("ResonantPlayback",serialize(player))
            }
            main.postDelayed(this,500)
        }
    }
    @ReactMethod fun observePlayback(active:Boolean,p:Promise) {
        if(active)playback(p) {
            observing=true
            main.removeCallbacks(tick)
            tick.run()
            null
        } else main.post {
            observing=false
            main.removeCallbacks(tick)
            p.resolve(null)
        }
    }

    init {
        context.addActivityEventListener(object:BaseActivityEventListener() {
            override fun onActivityResult(activity:Activity,requestCode:Int,resultCode:Int,data:Intent?) {
                if(requestCode!=853)return
                val promise=importPromise ?: return
                importPromise=null
                if(resultCode!=Activity.RESULT_OK||data==null){promise.resolve(0);return}
                val uris=if(data.clipData!=null) (0 until data.clipData!!.itemCount).map { data.clipData!!.getItemAt(it).uri } else listOfNotNull(data.data)
                background(promise) {
                    var count=0
                    for(uri in uris.take(100)) {
                        val id=UUID.randomUUID().toString()
                        val file=db.explicitPath(context,id)
                        val resolver=context.contentResolver
                        try {
                            resolver.openInputStream(uri)?.use { input ->
                                file.outputStream().use { out -> input.copyTo(out,128*1024) }
                            } ?: continue
                            val name=resolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use {
                                if(it.moveToFirst())it.getString(0) else null
                            } ?: "Local audio"
                            val metadata=MediaMetadataRetriever()
                            try {
                                metadata.setDataSource(context,uri)
                                fun tag(key:Int,fallback:String="")=metadata.extractMetadata(key)?.take(240) ?: fallback
                                val date=java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",java.util.Locale.US).apply {
                                    timeZone=java.util.TimeZone.getTimeZone("UTC")
                                }.format(java.util.Date())
                                val track=JSONObject().put("id",id).put("local",true).put("filename",name)
                                    .put("title",tag(MediaMetadataRetriever.METADATA_KEY_TITLE,name.substringBeforeLast('.')))
                                    .put("artist",tag(MediaMetadataRetriever.METADATA_KEY_ARTIST,"Unknown artist"))
                                    .put("album",tag(MediaMetadataRetriever.METADATA_KEY_ALBUM,"Unknown album"))
                                    .put("albumArtist",tag(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST))
                                    .put("genre",tag(MediaMetadataRetriever.METADATA_KEY_GENRE))
                                    .put("mime",tag(MediaMetadataRetriever.METADATA_KEY_MIMETYPE,"audio/*"))
                                    .put("duration",(tag(MediaMetadataRetriever.METADATA_KEY_DURATION).toLongOrNull() ?: 0)/1000.0)
                                    .put("bitrate",tag(MediaMetadataRetriever.METADATA_KEY_BITRATE).toIntOrNull() ?: 0)
                                    .put("codec","").put("lyrics","").put("trackNumber",0).put("discNumber",0)
                                    .put("liked",false).put("playCount",0).put("size",file.length()).put("hash",sha256(file))
                                    .put("createdAt",date).put("updatedAt",date)
                                metadata.embeddedPicture?.takeIf { it.size<=1024*1024 }?.let {
                                    val cover=File(context.filesDir,id+".cover")
                                    cover.writeBytes(it);track.put("nativeArtwork","file://"+cover.absolutePath)
                                }
                                require(track.getDouble("duration")>0) { "Unsupported audio file" }
                                db.writeTrack(track,true)
                                count++
                            } finally { metadata.release() }
                        } catch(e:Exception) { file.delete();File(context.filesDir,id+".cover").delete() }
                    }
                    count
                }
            }
        })
    }

    private fun background(promise:Promise, run:()->Any?) {
        io.execute { try { promise.resolve(run()) } catch(e:Exception){promise.reject("NATIVE",e.message,e)} }
    }
    private fun playback(promise:Promise,run:(MediaController)->Any?) {
        main.post {
            try {
                val future=connection ?: MediaController.Builder(context,
                    SessionToken(context,ComponentName(context,PlaybackService::class.java))).buildAsync().also { connection=it }
                future.addListener({
                    try {
                        val player=future.get()
                        controller=player
                        promise.resolve(run(player))
                    } catch(e:Exception) {
                        if(connection===future && controller==null){connection=null;MediaController.releaseFuture(future)}
                        promise.reject("PLAYBACK",e.cause?.message ?: e.message,e)
                    }
                },{ runnable -> main.post(runnable) })
            } catch(e:Exception){promise.reject("PLAYBACK",e.message,e)}
        }
    }

    @ReactMethod fun getCredentials(p:Promise)=background(p){Credentials.get(context)?.toString()}
    @ReactMethod fun saveCredentials(value:String,p:Promise)=background(p){Credentials.put(context,value);null}
    @ReactMethod fun resetCredentials(p:Promise)=background(p){Credentials.clear(context);null}
    @ReactMethod fun getLibrary(term:String,limit:Double,offset:Double,p:Promise)=background(p){
        JSONObject().put("tracks",db.tracks(term,limit.toInt().coerceIn(1,500),offset.toInt().coerceAtLeast(0)))
            .put("playlists",db.playlists()).put("downloads",db.downloads()).toString()
    }
    @ReactMethod fun getState(key:String,p:Promise)=background(p){db.state(key)}
    @ReactMethod fun setState(key:String,value:String,p:Promise)=background(p){db.save(key,value);null}
    @ReactMethod fun pending(p:Promise)=background(p){db.pending().toString()}
    @ReactMethod fun enqueue(value:String,p:Promise)=background(p){
        val op=JSONObject(value)
        val track=db.track(op.optString("id"))
        if(op.optString("kind")=="like"&&track?.optBoolean("local")==true) {
            track.put("liked",op.getBoolean("liked"));db.writeTrack(track,true)
        } else db.enqueue(op)
        null
    }
    @ReactMethod fun confirm(value:String,p:Promise)=background(p){db.confirm(JSONArray(value));null}
    @ReactMethod fun apply(value:String,p:Promise)=background(p){
        for(id in db.apply(JSONObject(value)))removeOffline(id)
        null
    }
    @ReactMethod fun importLocal(p:Promise) {
        main.post {
            val activity=context.currentActivity
            if(activity==null||importPromise!=null){p.reject("IMPORT","File picker is unavailable");return@post}
            try {
                importPromise=p
                activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("audio/*")
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true),853)
            } catch(e:Exception){importPromise=null;p.reject("IMPORT",e.message,e)}
        }
    }
    @ReactMethod fun startDownload(value:String,wifi:Boolean,p:Promise)=background(p){
        val ids=JSONArray(value)
        for(i in 0 until ids.length()) {
            val id=ids.getString(i)
            val track=db.track(id) ?: continue
            if(db.offline(context,id)!=null)continue
            val old=db.download(id)?.optString("state")
            if(old in listOf("Queued","Downloading","Waiting to retry"))continue
            db.writeDownload(id,JSONObject().put("id",id).put("state","Queued").put("size",track.getLong("size")).put("bytes",0))
            work.enqueueUniqueWork("audio-"+id,ExistingWorkPolicy.KEEP,OneTimeWorkRequestBuilder<OfflineWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(if(wifi)NetworkType.UNMETERED else NetworkType.CONNECTED).build())
                .setInputData(workDataOf("track" to id)).build())
        }
        null
    }
    private fun removeOffline(id:String) {
        work.cancelUniqueWork("audio-"+id).result.get()
        val file=db.explicitPath(context,id)
        file.delete();File(file.parentFile,id+".partial").delete();db.deleteDownload(id)
    }
    @ReactMethod fun removeDownload(id:String,p:Promise)=background(p){if(db.track(id)?.optBoolean("local")!=true)removeOffline(id);null}
    @ReactMethod fun playQueue(value:String,index:Double,p:Promise)=playback(p){
        val rows=JSONArray(value)
        val items=(0 until rows.length()).map { i -> mediaItem(rows.getJSONObject(i)) }
        if(items.isNotEmpty()){it.setMediaItems(items,index.toInt().coerceIn(0,items.lastIndex),0);it.prepare();it.play()}
        null
    }
    @ReactMethod fun addQueue(value:String,next:Boolean,p:Promise)=playback(p){
        val item=mediaItem(JSONObject(value))
        if(next&&it.mediaItemCount>0)it.addMediaItem(it.currentMediaItemIndex+1,item) else it.addMediaItem(item)
        null
    }
    @ReactMethod fun command(name:String,value:Double,second:Double,p:Promise)=playback(p){
        when(name) {
            "toggle" -> if(it.playWhenReady && it.playbackState!=Player.STATE_ENDED && it.playerError==null)it.pause() else {
                if(it.playbackState==Player.STATE_IDLE)it.prepare()
                if(it.playbackState==Player.STATE_ENDED)it.seekToDefaultPosition()
                it.play()
            }
            "pause" -> it.pause()
            "next" -> it.seekToNextMediaItem()
            "previous" -> it.seekToPrevious()
            "seek" -> it.seekTo((value*1000).toLong().coerceAtLeast(0))
            "index" -> if(value.toInt() in 0 until it.mediaItemCount){it.seekToDefaultPosition(value.toInt());if(it.playbackState==Player.STATE_IDLE)it.prepare();it.play()}
            "shuffle" -> it.shuffleModeEnabled=!it.shuffleModeEnabled
            "repeat" -> it.repeatMode=(it.repeatMode+1)%3
            "move" -> if(value.toInt() in 0 until it.mediaItemCount && second.toInt() in 0 until it.mediaItemCount)it.moveMediaItem(value.toInt(),second.toInt())
            "remove" -> if(value.toInt() in 0 until it.mediaItemCount)it.removeMediaItem(value.toInt())
            "clear" -> {it.pause();it.clearMediaItems()}
            "volume" -> audio.setStreamVolume(AudioManager.STREAM_MUSIC,(value.coerceIn(0.0,1.0)*audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)).toInt(),0)
            "output" -> {
                val activity=context.currentActivity
                val shown=activity!=null && android.os.Build.VERSION.SDK_INT>=34 &&
                    android.media.MediaRouter2.getInstance(activity).showSystemOutputSwitcher()
                if(!shown)activity?.startActivity(Intent(android.provider.Settings.ACTION_SOUND_SETTINGS))
            }
        }
        null
    }
    private fun serialize(it:MediaController):String {
        val rows=JSONArray()
        for(i in 0 until it.mediaItemCount) {
            val item=it.getMediaItemAt(i)
            rows.put(JSONObject().put("id",item.mediaId).put("title",item.mediaMetadata.title?.toString() ?: "")
                .put("artist",item.mediaMetadata.artist?.toString() ?: "").put("artwork",item.mediaMetadata.artworkUri?.toString() ?: ""))
        }
        return JSONObject().put("queue",rows).put("index",it.currentMediaItemIndex).put("playing",it.isPlaying)
            .put("position",it.currentPosition/1000.0).put("duration",it.duration.coerceAtLeast(0)/1000.0).put("shuffle",it.shuffleModeEnabled)
            .put("repeat",it.repeatMode).put("buffering",it.playbackState==Player.STATE_BUFFERING)
            .put("volume",audio.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble()/audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1))
            .put("error",it.playerError?.errorCodeName ?: "").toString()
    }
    override fun invalidate() {
        main.post { observing=false;main.removeCallbacks(tick);connection?.let { MediaController.releaseFuture(it) };controller=null;connection=null }
        io.shutdown()
        super.invalidate()
    }
}
