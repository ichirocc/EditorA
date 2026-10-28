package editora.core

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

enum class LineEnding(val value: String) { LF("\n"), CRLF("\r\n") }

/**
 * Supported file encodings. [charsetNames] are tried in order because the
 * Java and Android runtimes do not ship identical charset aliases.
 */
enum class TextEncoding(val displayName: String, private val charsetNames: List<String>) {
	UTF_8("UTF-8", listOf("UTF-8")),

	/** Windows Shift_JIS (CP932), a superset including ①, ㈱ and NEC/IBM extensions. */
	SHIFT_JIS("Shift_JIS", listOf("windows-31j", "MS932", "Shift_JIS")),
	EUC_JP("EUC-JP", listOf("EUC-JP")),
	ISO_2022_JP("ISO-2022-JP", listOf("ISO-2022-JP")),
	UTF_16LE("UTF-16LE", listOf("UTF-16LE")),
	UTF_16BE("UTF-16BE", listOf("UTF-16BE"));

	val charset: Charset by lazy {
		charsetNames.firstNotNullOfOrNull { name -> runCatching { Charset.forName(name) }.getOrNull() }
			?: throw IllegalStateException("No charset available for $displayName")
	}

	val isAvailable: Boolean
		get() = charsetNames.any { runCatching { Charset.isSupported(it) }.getOrDefault(false) }

	/** UTF-16 files are always written with a byte order mark. */
	val alwaysHasBom: Boolean get() = this == UTF_16LE || this == UTF_16BE
}

/** Decoded file content plus what is needed to write it back unchanged. */
data class TextFile(
	/** Text with line endings normalized to `\n`. */
	val text: String,
	val lineEnding: LineEnding,
	val hasBom: Boolean,
	val encoding: TextEncoding = TextEncoding.UTF_8,
)

sealed class DecodeResult {
	data class Success(val file: TextFile) : DecodeResult()
	data object Binary : DecodeResult()

	/** Not valid in any supported encoding (or in the one that was forced). */
	data object Unsupported : DecodeResult()
}

sealed class EncodeResult {
	class Success(val bytes: ByteArray) : EncodeResult()

	/** [character] at 1-based [line]/[column] has no representation in the target encoding. */
	data class Unmappable(val character: String, val line: Int, val column: Int) : EncodeResult()
}

object TextFiles {
	private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
	private val UTF16LE_BOM = byteArrayOf(0xFF.toByte(), 0xFE.toByte())
	private val UTF16BE_BOM = byteArrayOf(0xFE.toByte(), 0xFF.toByte())
	private const val ESC: Byte = 0x1B

	/**
	 * Decodes [bytes], detecting the encoding unless [forced] is given.
	 *
	 * Detection order: byte order mark, ISO-2022-JP escape sequences, strict
	 * UTF-8, then whichever of Shift_JIS and EUC-JP decodes cleanly and reads
	 * more like Japanese text.
	 */
	fun decode(bytes: ByteArray, forced: TextEncoding? = null): DecodeResult {
		val bom = detectBom(bytes)
		if (forced != null) {
			val hasBom = bom?.first == forced
			val offset = if (hasBom) bom!!.second else 0
			if (!forced.isUtf16() && containsNul(bytes, offset)) return DecodeResult.Binary
			val text = strictDecode(bytes, offset, forced) ?: return DecodeResult.Unsupported
			return DecodeResult.Success(normalize(text, hasBom || forced.alwaysHasBom, forced))
		}

		if (bom != null) {
			val (encoding, length) = bom
			val text = strictDecode(bytes, length, encoding) ?: return DecodeResult.Unsupported
			return DecodeResult.Success(normalize(text, hasBom = true, encoding))
		}

		if (containsNul(bytes, 0)) return DecodeResult.Binary

		if (looksLikeIso2022Jp(bytes)) {
			strictDecode(bytes, 0, TextEncoding.ISO_2022_JP)?.let {
				return DecodeResult.Success(normalize(it, hasBom = false, TextEncoding.ISO_2022_JP))
			}
		}

		strictDecode(bytes, 0, TextEncoding.UTF_8)?.let {
			return DecodeResult.Success(normalize(it, hasBom = false, TextEncoding.UTF_8))
		}

		val best = listOf(TextEncoding.SHIFT_JIS, TextEncoding.EUC_JP)
			.filter { it.isAvailable }
			.mapNotNull { encoding -> strictDecode(bytes, 0, encoding)?.let { encoding to it } }
			// Stable sort keeps Shift_JIS first on a tie; it is the more common legacy encoding.
			.sortedByDescending { (_, text) -> japaneseScore(text) }
			.firstOrNull()
			?: return DecodeResult.Unsupported
		return DecodeResult.Success(normalize(best.second, hasBom = false, best.first))
	}

	/** Encodes [text] for saving; fails rather than writing replacement characters. */
	fun encode(text: String, lineEnding: LineEnding, encoding: TextEncoding, hasBom: Boolean): EncodeResult {
		val content = if (lineEnding == LineEnding.CRLF) text.replace("\n", "\r\n") else text
		val encoder = encoding.charset.newEncoder()
			.onMalformedInput(CodingErrorAction.REPORT)
			.onUnmappableCharacter(CodingErrorAction.REPORT)
		val body = try {
			val buffer = encoder.encode(CharBuffer.wrap(content))
			ByteArray(buffer.remaining()).also { buffer.get(it) }
		} catch (_: CharacterCodingException) {
			return firstUnmappable(text, encoding)
		}
		val bom = when {
			encoding == TextEncoding.UTF_16LE -> UTF16LE_BOM
			encoding == TextEncoding.UTF_16BE -> UTF16BE_BOM
			encoding == TextEncoding.UTF_8 && hasBom -> UTF8_BOM
			else -> ByteArray(0)
		}
		return EncodeResult.Success(bom + body)
	}

	private fun TextEncoding.isUtf16() = this == TextEncoding.UTF_16LE || this == TextEncoding.UTF_16BE

	private fun detectBom(bytes: ByteArray): Pair<TextEncoding, Int>? = when {
		bytes.startsWith(UTF8_BOM) -> TextEncoding.UTF_8 to 3
		bytes.startsWith(UTF16LE_BOM) -> TextEncoding.UTF_16LE to 2
		bytes.startsWith(UTF16BE_BOM) -> TextEncoding.UTF_16BE to 2
		else -> null
	}

	private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
		if (size < prefix.size) return false
		for (i in prefix.indices) if (this[i] != prefix[i]) return false
		return true
	}

	private fun containsNul(bytes: ByteArray, offset: Int): Boolean {
		val end = minOf(bytes.size, offset + 8192)
		for (k in offset until end) if (bytes[k] == 0.toByte()) return true
		return false
	}

	/** 7-bit data containing a JIS X 0208 designation (ESC $ B or ESC $ @). */
	private fun looksLikeIso2022Jp(bytes: ByteArray): Boolean {
		var sawDesignation = false
		for (i in bytes.indices) {
			val b = bytes[i].toInt() and 0xFF
			if (b >= 0x80) return false
			if (bytes[i] == ESC && i + 2 < bytes.size && bytes[i + 1] == '$'.code.toByte() &&
				(bytes[i + 2] == 'B'.code.toByte() || bytes[i + 2] == '@'.code.toByte())
			) {
				sawDesignation = true
			}
		}
		return sawDesignation
	}

	private fun strictDecode(bytes: ByteArray, offset: Int, encoding: TextEncoding): String? {
		if (!encoding.isAvailable) return null
		val decoder = encoding.charset.newDecoder()
			.onMalformedInput(CodingErrorAction.REPORT)
			.onUnmappableCharacter(CodingErrorAction.REPORT)
		return try {
			decoder.decode(ByteBuffer.wrap(bytes, offset, bytes.size - offset)).toString()
		} catch (_: CharacterCodingException) {
			null
		}
	}

	/**
	 * Higher for text made of common Japanese characters. Half-width katakana
	 * and rarely used symbols are what a wrong guess between Shift_JIS and
	 * EUC-JP typically produces, so they count against.
	 */
	internal fun japaneseScore(text: String): Int {
		var score = 0
		for (c in text) {
			score += when (c) {
				in 'ぁ'..'ゖ', in 'ァ'..'ヺ', 'ー' -> 3 // hiragana, katakana
				in '一'..'鿿' -> 2 // common kanji
				in '　'..'〿', in '！'..'～' -> 1 // Japanese punctuation, full-width ASCII
				in '｡'..'ﾟ' -> -1 // half-width katakana
				in '\u0080'..'ÿ', in ''..'' -> -3 // Latin-1 symbols, private use
				else -> 0
			}
		}
		return score
	}

	private fun normalize(raw: String, hasBom: Boolean, encoding: TextEncoding): TextFile {
		val lineEnding = if (raw.contains("\r\n")) LineEnding.CRLF else LineEnding.LF
		val text = if (lineEnding == LineEnding.CRLF) raw.replace("\r\n", "\n") else raw
		return TextFile(text, lineEnding, hasBom, encoding)
	}

	private fun firstUnmappable(text: String, encoding: TextEncoding): EncodeResult.Unmappable {
		val encoder = encoding.charset.newEncoder()
		var line = 1
		var column = 1
		var i = 0
		while (i < text.length) {
			val codePoint = text.codePointAt(i)
			val character = String(Character.toChars(codePoint))
			if (!encoder.canEncode(character)) return EncodeResult.Unmappable(character, line, column)
			if (codePoint == '\n'.code) {
				line++
				column = 1
			} else {
				column++
			}
			i += Character.charCount(codePoint)
		}
		// Malformed input such as an unpaired surrogate.
		return EncodeResult.Unmappable("?", line, column)
	}
}
