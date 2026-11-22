package com.resonant

import android.content.Context
import android.net.Uri
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Semaphore

internal fun sha256(file:File):String {
    val hash=MessageDigest.getInstance("SHA-256")
    file.inputStream().use { stream ->
        val buffer=ByteArray(128*1024)
        while(true) {
            val read=stream.read(buffer)
            if(read<0)break
            hash.update(buffer,0,read)
        }
    }
    return hash.digest().joinToString("") { "%02x".format(it) }
}

class OfflineWorker(context:Context, params:WorkerParameters):Worker(context,params) {
    companion object { private val slots=Semaphore(2,true) }
    override fun doWork():Result {
        val id=inputData.getString("track") ?: return Result.failure()
        val db=LibraryDb.get(applicationContext)
        val track=db.track(id) ?: return Result.failure()
        val target=db.explicitPath(applicationContext,id)
        val temp=File(target.parentFile,id+".partial")
        val size=track.getLong("size")
        fun update(state:String, bytes:Long, error:String="") {
            if(!isStopped&&db.track(id)!=null) db.writeDownload(id,JSONObject().put("id",id).put("state",state)
                .put("bytes",bytes).put("size",size).put("error",error))
        }
        var locked=false
        try {
            slots.acquire()
            locked=true
            if(isStopped)return Result.failure()
            if(target.isFile&&target.length()==size&&sha256(target)==track.getString("hash")) {
                update("Complete",size)
                return Result.success()
            }
            if(temp.length()>size)temp.delete()
            if(target.parentFile!!.usableSpace<size-temp.length()+10*1024*1024)
                throw IOException("Insufficient storage")
            if(temp.length()<size) {
                val grant=Credentials.url(applicationContext,id,true)
                val uri=Uri.parse(grant.getString("url"))
                val connection=URL(uri.toString()).openConnection() as HttpURLConnection
                try {
                    val offset=temp.length()
                    connection.connectTimeout=10000
                    connection.readTimeout=12000
                    if(offset>0)connection.setRequestProperty("Range","bytes="+offset+"-")
                    val status=connection.responseCode
                    val resume=status==206 && connection.getHeaderField("Content-Range")?.startsWith("bytes "+offset+"-")==true
                    if(status!=200&&!resume)throw IOException("Download returned HTTP "+status)
                    var written=if(resume)offset else 0
                    var last=0L
                    connection.inputStream.use { stream ->
                        java.io.FileOutputStream(temp,resume).use { out ->
                            val buffer=ByteArray(128*1024)
                            while(!isStopped) {
                                val n=stream.read(buffer)
                                if(n<0)break
                                written+=n
                                if(written>size)throw IOException("Download exceeded file size")
                                out.write(buffer,0,n)
                                val now=android.os.SystemClock.elapsedRealtime()
                                if(now-last>=500) { update("Downloading",written);last=now }
                            }
                        }
                    }
                } finally { connection.disconnect() }
            }
            if(isStopped||db.track(id)==null)return Result.failure()
            if(temp.length()!=size)throw IOException("Incomplete audio transfer")
            if(sha256(temp)!=track.getString("hash")) {temp.delete();throw IOException("SHA-256 verification failed")}
            if(isStopped||db.track(id)==null)return Result.failure()
            if(!temp.renameTo(target))throw IOException("Could not save the offline file")
            update("Complete",size)
            return Result.success()
        } catch(e:Exception) {
            if(isStopped)return Result.failure()
            val retry=runAttemptCount<3 && e.message!="Insufficient storage"
            update(if(retry)"Waiting to retry" else "Failed",temp.length(),e.message ?: "Download failed")
            return if(retry)Result.retry() else Result.failure()
        } finally { if(locked)slots.release() }
    }
}
