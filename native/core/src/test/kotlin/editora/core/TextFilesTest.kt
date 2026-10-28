package editora.core

import java.nio.charset.Charset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TextFilesTest {
	private val sample = "日本語のテキスト。\nソースコードの表示、①㈱も。\n"

	private fun bytesOf(text: String, charset: String) = text.toByteArray(Charset.forName(charset))

	private fun decodeOk(bytes: ByteArray, forced: TextEncoding? = null) =
		(TextFiles.decode(bytes, forced) as DecodeResult.Success).file

	private fun encodeOk(file: TextFile) =
		(TextFiles.encode(file.text, file.lineEnding, file.encoding, file.hasBom) as EncodeResult.Success).bytes

	@Test
	fun roundTripsUtf8CrlfAndBom() {
		val original = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "a\r\n日本\r\n".toByteArray()
		val file = decodeOk(original)
		assertEquals(TextFile("a\n日本\n", LineEnding.CRLF, hasBom = true, TextEncoding.UTF_8), file)
		assertTrue(original.contentEquals(encodeOk(file)))
	}

	@Test
	fun plainAsciiIsUtf8() {
		assertEquals(TextFile("x\ny", LineEnding.LF, hasBom = false, TextEncoding.UTF_8), decodeOk("x\ny".toByteArray()))
	}

	@Test
	fun detectsAndRoundTripsShiftJis() {
		// "ソ" and "表" have 0x5C ('\') as their second byte in Shift_JIS.
		val original = bytesOf(sample.replace("\n", "\r\n"), "windows-31j")
		val file = decodeOk(original)
		assertEquals(TextEncoding.SHIFT_JIS, file.encoding)
		assertEquals(sample, file.text)
		assertEquals(LineEnding.CRLF, file.lineEnding)
		assertTrue(original.contentEquals(encodeOk(file)))
	}

	@Test
	fun detectsAndRoundTripsEucJp() {
		val text = "日本語のテキスト。ソースコードの表示。\n"
		val original = bytesOf(text, "EUC-JP")
		val file = decodeOk(original)
		assertEquals(TextEncoding.EUC_JP, file.encoding)
		assertEquals(text, file.text)
		assertTrue(original.contentEquals(encodeOk(file)))
	}

	@Test
	fun detectsAndRoundTripsIso2022Jp() {
		val text = "件名：日本語メール\nASCII line\n"
		val original = bytesOf(text, "ISO-2022-JP")
		val file = decodeOk(original)
		assertEquals(TextEncoding.ISO_2022_JP, file.encoding)
		assertEquals(text, file.text)
		assertTrue(original.contentEquals(encodeOk(file)))
	}

	@Test
	fun detectsUtf16ByBom() {
		val le = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + bytesOf("日本\n", "UTF-16LE")
		val file = decodeOk(le)
		assertEquals(TextEncoding.UTF_16LE, file.encoding)
		assertEquals("日本\n", file.text)
		assertTrue(le.contentEquals(encodeOk(file)))

		val be = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + bytesOf("x", "UTF-16BE")
		assertEquals(TextEncoding.UTF_16BE, decodeOk(be).encoding)
	}

	@Test
	fun shortShiftJisAndHalfWidthKatakana() {
		assertEquals("あ", decodeOk(bytesOf("あ", "windows-31j")).text)
		val halfWidth = "ﾃｽﾄ abc"
		assertEquals(halfWidth, decodeOk(bytesOf(halfWidth, "windows-31j")).text)
	}

	@Test
	fun forcedEncodingReopensWithAnotherCharset() {
		val sjis = bytesOf("表示", "windows-31j")
		assertEquals("表示", decodeOk(sjis, TextEncoding.SHIFT_JIS).text)
		assertEquals(DecodeResult.Unsupported, TextFiles.decode(sjis, TextEncoding.UTF_8))
	}

	@Test
	fun convertsBetweenEncodings() {
		val file = decodeOk(bytesOf(sample, "windows-31j"))
		val asUtf8 = TextFiles.encode(file.text, file.lineEnding, TextEncoding.UTF_8, hasBom = false) as EncodeResult.Success
		assertEquals(sample, String(asUtf8.bytes, Charsets.UTF_8))
	}

	@Test
	fun unmappableCharacterIsReportedWithPosition() {
		val result = TextFiles.encode("日本\nab😀c", LineEnding.LF, TextEncoding.SHIFT_JIS, hasBom = false)
		assertEquals(EncodeResult.Unmappable("😀", line = 2, column = 3), result)
	}

	@Test
	fun rejectsBinaryAndUndecodableBytes() {
		assertEquals(DecodeResult.Binary, TextFiles.decode(byteArrayOf(0x50, 0x4B, 0x00, 0x03)))
		// 0xFF is not a valid lead byte in UTF-8, Shift_JIS or EUC-JP.
		assertEquals(DecodeResult.Unsupported, TextFiles.decode(byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x41)))
	}

	@Test
	fun japaneseScorePrefersKanaOverHalfWidthAndSymbols() {
		assertTrue(TextFiles.japaneseScore("ひらがなカタカナ漢字") > TextFiles.japaneseScore("ﾋﾗｶﾞﾅ¥§"))
	}

	@Test
	fun detectsLanguageFromFileName() {
		assertEquals(Languages.JAVASCRIPT, Languages.forFileName("app.tsx"))
		assertEquals(Languages.MARKUP, Languages.forFileName("INDEX.HTML"))
		assertEquals(Languages.SHELL, Languages.forFileName(".gitignore"))
		assertEquals(Languages.PLAIN, Languages.forFileName("README"))
		assertEquals(Languages.PLAIN, Languages.forFileName(null))
	}
}
