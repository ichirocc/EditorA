package editora.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

enum class LineEnding(val value: String) { LF("\n"), CRLF("\r\n") }

/** Decoded file content plus what is needed to write it back unchanged. */
data class TextFile(
	/** Text with line endings normalized to `\n`. */
	val text: String,
	val lineEnding: LineEnding,
	val hasBom: Boolean,
)

sealed class DecodeResult {
	data class Success(val file: TextFile) : DecodeResult()
	data object Binary : DecodeResult()
	data object NotUtf8 : DecodeResult()
}

object TextFiles {
	private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

	fun decode(bytes: ByteArray): DecodeResult {
		val hasBom = bytes.size >= 3 && bytes[0] == UTF8_BOM[0] && bytes[1] == UTF8_BOM[1] && bytes[2] == UTF8_BOM[2]
		val offset = if (hasBom) 3 else 0
		val probeEnd = minOf(bytes.size, offset + 8192)
		for (k in offset until probeEnd) {
			if (bytes[k] == 0.toByte()) return DecodeResult.Binary
		}

		val decoder = StandardCharsets.UTF_8.newDecoder()
			.onMalformedInput(CodingErrorAction.REPORT)
			.onUnmappableCharacter(CodingErrorAction.REPORT)
		val raw = try {
			decoder.decode(ByteBuffer.wrap(bytes, offset, bytes.size - offset)).toString()
		} catch (_: CharacterCodingException) {
			return DecodeResult.NotUtf8
		}

		val lineEnding = if (raw.contains("\r\n")) LineEnding.CRLF else LineEnding.LF
		val text = if (lineEnding == LineEnding.CRLF) raw.replace("\r\n", "\n") else raw
		return DecodeResult.Success(TextFile(text, lineEnding, hasBom))
	}

	fun encode(text: String, lineEnding: LineEnding, hasBom: Boolean): ByteArray {
		val content = if (lineEnding == LineEnding.CRLF) text.replace("\n", "\r\n") else text
		val body = content.toByteArray(StandardCharsets.UTF_8)
		return if (hasBom) UTF8_BOM + body else body
	}
}
