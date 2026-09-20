package app.armada.remote

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream

sealed class ImagePrepare {
    data class Ok(val bytes: ByteArray, val mime: String, val name: String) : ImagePrepare()
    data class Fail(val code: String) : ImagePrepare()
}

fun clipboardImageUri(context: Context): Uri? {
    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.primaryClip
        ?: return null
    if (clip.itemCount <= 0) return null
    return clip.getItemAt(0).uri
}

fun prepareImageForUpload(context: Context, uri: Uri, fallbackName: String): ImagePrepare {
    val bytes = runCatching {
        context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }.getOrNull() ?: return ImagePrepare.Fail("CONVERT")
    val magic = imageMagicMime(bytes)
    if (magic != null) {
        if (bytes.size > MAX_BLOB_BYTES) return ImagePrepare.Fail("ATTACHMENT_TOO_LARGE")
        return ImagePrepare.Ok(bytes, magic, nameFor(fallbackName, magic))
    }
    val bitmap = decodeBitmap(context, uri) ?: return ImagePrepare.Fail("CONVERT")
    val out = ByteArrayOutputStream()
    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)) {
        bitmap.recycle()
        return ImagePrepare.Fail("CONVERT")
    }
    bitmap.recycle()
    val jpeg = out.toByteArray()
    if (jpeg.isEmpty()) return ImagePrepare.Fail("CONVERT")
    if (jpeg.size > MAX_BLOB_BYTES) return ImagePrepare.Fail("ATTACHMENT_TOO_LARGE")
    return ImagePrepare.Ok(jpeg, "image/jpeg", nameFor(fallbackName, "image/jpeg"))
}

private fun decodeBitmap(context: Context, uri: Uri): Bitmap? {
    return runCatching {
        if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            context.contentResolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it) }
        }
    }.getOrNull()
}

private fun nameFor(raw: String, mime: String): String {
    val base = raw.substringAfterLast('/').ifBlank { "image" }
    val stem = base.substringBeforeLast('.', base).ifBlank { "image" }
    return if (mime == "image/png") "$stem.png" else "$stem.jpg"
}
