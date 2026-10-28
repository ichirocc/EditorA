package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TextFilesTest {
	@Test
	fun roundTripsCrlfAndBom() {
		val original = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "a\r\n日本\r\n".toByteArray()
		val decoded = TextFiles.decode(original) as DecodeResult.Success
		assertEquals("a\n日本\n", decoded.file.text)
		assertEquals(LineEnding.CRLF, decoded.file.lineEnding)
		assertTrue(decoded.file.hasBom)
		val encoded = TextFiles.encode(decoded.file.text, decoded.file.lineEnding, decoded.file.hasBom)
		assertTrue(original.contentEquals(encoded))
	}

	@Test
	fun plainUtf8() {
		val decoded = TextFiles.decode("x\ny".toByteArray()) as DecodeResult.Success
		assertEquals(TextFile("x\ny", LineEnding.LF, hasBom = false), decoded.file)
	}

	@Test
	fun rejectsBinaryAndInvalidUtf8() {
		assertEquals(DecodeResult.Binary, TextFiles.decode(byteArrayOf(0x50, 0x4B, 0x00, 0x03)))
		assertEquals(DecodeResult.NotUtf8, TextFiles.decode(byteArrayOf(0x82.toByte(), 0xA0.toByte())))
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
