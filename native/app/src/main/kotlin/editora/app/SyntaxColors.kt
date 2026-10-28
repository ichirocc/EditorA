package editora.app

import android.content.res.Configuration
import android.content.res.Resources
import editora.core.TokenType

/** Editor palette for light and dark mode. */
class SyntaxColors(
	private val byType: Map<TokenType, Int>,
	val gutterText: Int,
	val gutterBackground: Int,
	val gutterDivider: Int,
	val searchMatch: Int,
) {
	fun colorOf(type: TokenType): Int = byType.getValue(type)

	companion object {
		private val LIGHT = SyntaxColors(
			mapOf(
				TokenType.KEYWORD to 0xFF0033B3.toInt(),
				TokenType.STRING to 0xFF067D17.toInt(),
				TokenType.NUMBER to 0xFF1750EB.toInt(),
				TokenType.COMMENT to 0xFF8C8C8C.toInt(),
				TokenType.TAG to 0xFF0033B3.toInt(),
				TokenType.ATTRIBUTE to 0xFF871094.toInt(),
				TokenType.HEADING to 0xFF0033B3.toInt(),
			),
			gutterText = 0xFF9E9E9E.toInt(),
			gutterBackground = 0xFFF3F3F3.toInt(),
			gutterDivider = 0xFFE0E0E0.toInt(),
			searchMatch = 0x80FFD54F.toInt(),
		)

		private val DARK = SyntaxColors(
			mapOf(
				TokenType.KEYWORD to 0xFFCC7832.toInt(),
				TokenType.STRING to 0xFF6A8759.toInt(),
				TokenType.NUMBER to 0xFF6897BB.toInt(),
				TokenType.COMMENT to 0xFF808080.toInt(),
				TokenType.TAG to 0xFFE8BF6A.toInt(),
				TokenType.ATTRIBUTE to 0xFFBABABA.toInt(),
				TokenType.HEADING to 0xFFCC7832.toInt(),
			),
			gutterText = 0xFF6E6E6E.toInt(),
			gutterBackground = 0xFF1E1F22.toInt(),
			gutterDivider = 0xFF393B40.toInt(),
			searchMatch = 0x80B8860B.toInt(),
		)

		fun isNight(resources: Resources): Boolean =
			resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

		fun forResources(resources: Resources): SyntaxColors = if (isNight(resources)) DARK else LIGHT
	}
}
