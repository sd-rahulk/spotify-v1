package com.resonant

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object Credentials {
    private const val ALIAS="resonant-device"
    private fun key(): SecretKey {
        val keystore=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (keystore.getKey(ALIAS,null) as? SecretKey) ?: KeyGenerator.getInstance("AES","AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun put(context: Context, raw:String) {
        val value=JSONObject(raw)
        val uri=URI(value.getString("base"))
        require(uri.host!=null && uri.userInfo==null && uri.query==null && uri.fragment==null && (uri.scheme=="https" ||
            (BuildConfig.DEBUG && uri.scheme=="http" && uri.host in listOf("127.0.0.1","localhost","10.0.2.2")))) { "Use an HTTPS API URL" }
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE,key())
        val encoded=Base64.encodeToString(cipher.iv+cipher.doFinal(raw.toByteArray(Charsets.UTF_8)),Base64.NO_WRAP)
        check(context.getSharedPreferences("secure",0).edit().putString("device",encoded).commit()) { "Could not save credentials" }
    }
    fun get(context: Context): JSONObject? {
        val encoded=context.getSharedPreferences("secure",0).getString("device",null) ?: return null
        val data=Base64.decode(encoded,Base64.NO_WRAP)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,data.copyOfRange(0,12)))
        return JSONObject(cipher.doFinal(data.copyOfRange(12,data.size)).toString(Charsets.UTF_8))
    }
    fun clear(context: Context) { context.getSharedPreferences("secure",0).edit().clear().commit() }
    fun url(context: Context, id:String, download:Boolean=false): JSONObject {
        val value=get(context) ?: throw java.io.IOException("Pair your device to stream this track")
        val destination=value.getString("base").trimEnd('/')+"/api/tracks/"+id+if(download)"/download-url" else "/stream-url"
        val connection=URL(destination).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout=8000
            connection.readTimeout=10000
            connection.instanceFollowRedirects=false
            connection.setRequestProperty("Authorization","Bearer "+value.getString("token"))
            if(connection.responseCode!=200) throw java.io.IOException("Could not authorize audio ("+connection.responseCode+")")
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
    }
}
