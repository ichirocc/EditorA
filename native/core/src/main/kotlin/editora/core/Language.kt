package editora.core

/** How a language is tokenized. */
enum class LexerKind { PLAIN, CODE, MARKUP, MARKDOWN }

/**
 * Describes enough of a language's syntax for [Lexer] to colour it.
 *
 * @property stringDelimiters single-line string quotes.
 * @property multilineDelimiters string delimiters that may span lines
 *   (Python triple quotes, JavaScript template literals, ...).
 */
class Language(
	val id: String,
	val displayName: String,
	val kind: LexerKind,
	val extensions: Set<String> = emptySet(),
	val fileNames: Set<String> = emptySet(),
	val lineComments: List<String> = emptyList(),
	val blockComment: Pair<String, String>? = null,
	val stringDelimiters: Set<Char> = emptySet(),
	val multilineDelimiters: List<String> = emptyList(),
	val keywords: Set<String> = emptySet(),
	val caseInsensitiveKeywords: Boolean = false,
) {
	fun isKeyword(word: String): Boolean =
		if (caseInsensitiveKeywords) word.lowercase() in keywords else word in keywords
}

object Languages {
	val PLAIN = Language("plain", "Plain text", LexerKind.PLAIN, setOf("txt", "text", "log"))

	private val C_LIKE_COMMENTS = listOf("//")
	private val C_BLOCK = "/*" to "*/"

	val JAVASCRIPT = Language(
		"javascript", "JavaScript", LexerKind.CODE,
		extensions = setOf("js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"),
		lineComments = C_LIKE_COMMENTS,
		blockComment = C_BLOCK,
		stringDelimiters = setOf('"', '\''),
		multilineDelimiters = listOf("`"),
		keywords = setOf(
			"abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
			"continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
			"export", "extends", "false", "finally", "for", "from", "function", "get", "if",
			"implements", "import", "in", "instanceof", "interface", "keyof", "let", "namespace",
			"new", "null", "of", "private", "protected", "public", "readonly", "return", "set",
			"static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
			"undefined", "var", "void", "while", "with", "yield",
		),
	)

	val JSON = Language(
		"json", "JSON", LexerKind.CODE,
		extensions = setOf("json", "jsonc", "json5", "webmanifest"),
		lineComments = C_LIKE_COMMENTS,
		blockComment = C_BLOCK,
		stringDelimiters = setOf('"'),
		keywords = setOf("true", "false", "null"),
	)

	val CSS = Language(
		"css", "CSS", LexerKind.CODE,
		extensions = setOf("css", "scss", "less"),
		lineComments = emptyList(),
		blockComment = C_BLOCK,
		stringDelimiters = setOf('"', '\''),
		keywords = setOf("important", "inherit", "initial", "unset", "none", "auto"),
	)

	val PYTHON = Language(
		"python", "Python", LexerKind.CODE,
		extensions = setOf("py", "pyw", "pyi"),
		lineComments = listOf("#"),
		stringDelimiters = setOf('"', '\''),
		multilineDelimiters = listOf("\"\"\"", "'''"),
		keywords = setOf(
			"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
			"continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
			"global", "if", "import", "in", "is", "lambda", "match", "case", "nonlocal", "not",
			"or", "pass", "raise", "return", "self", "try", "while", "with", "yield",
		),
	)

	val KOTLIN_JAVA = Language(
		"kotlin", "Kotlin / Java", LexerKind.CODE,
		extensions = setOf("kt", "kts", "java", "gradle", "groovy", "scala", "swift", "dart"),
		lineComments = C_LIKE_COMMENTS,
		blockComment = C_BLOCK,
		stringDelimiters = setOf('"', '\''),
		multilineDelimiters = listOf("\"\"\""),
		keywords = setOf(
			"abstract", "as", "boolean", "break", "byte", "case", "catch", "char", "class",
			"companion", "const", "continue", "data", "default", "do", "double", "else", "enum",
			"extends", "false", "final", "finally", "float", "for", "fun", "if", "implements",
			"import", "in", "int", "interface", "internal", "is", "lateinit", "long", "new",
			"null", "object", "open", "override", "package", "private", "protected", "public",
			"return", "sealed", "short", "static", "super", "suspend", "switch", "this", "throw",
			"throws", "true", "try", "val", "var", "void", "when", "while",
		),
	)

	val C_FAMILY = Language(
		"c", "C / C++ / C# / Go / Rust", LexerKind.CODE,
		extensions = setOf("c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "go", "rs", "m", "mm"),
		lineComments = C_LIKE_COMMENTS,
		blockComment = C_BLOCK,
		stringDelimiters = setOf('"', '\''),
		multilineDelimiters = listOf("`"),
		keywords = setOf(
			"auto", "bool", "break", "case", "char", "class", "const", "continue", "default",
			"defer", "delete", "do", "double", "else", "enum", "extern", "false", "float", "fn",
			"for", "func", "go", "goto", "if", "impl", "import", "include", "int", "let", "long",
			"loop", "match", "mod", "mut", "namespace", "new", "nullptr", "package", "private",
			"protected", "pub", "public", "return", "self", "short", "signed", "sizeof", "static",
			"struct", "switch", "template", "this", "trait", "true", "typedef", "union",
			"unsigned", "use", "using", "var", "virtual", "void", "while",
		),
	)

	val SHELL = Language(
		"shell", "Shell", LexerKind.CODE,
		extensions = setOf("sh", "bash", "zsh", "fish", "env", "ini", "conf", "properties", "toml", "yaml", "yml"),
		fileNames = setOf(".bashrc", ".zshrc", ".profile", ".gitignore", ".gitattributes", ".editorconfig"),
		lineComments = listOf("#"),
		stringDelimiters = setOf('"', '\''),
		keywords = setOf(
			"case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function",
			"if", "in", "local", "return", "then", "true", "false", "until", "while",
		),
	)

	val SQL = Language(
		"sql", "SQL", LexerKind.CODE,
		extensions = setOf("sql"),
		lineComments = listOf("--"),
		blockComment = C_BLOCK,
		stringDelimiters = setOf('\'', '"'),
		caseInsensitiveKeywords = true,
		keywords = setOf(
			"select", "from", "where", "insert", "into", "values", "update", "set", "delete",
			"create", "table", "drop", "alter", "index", "join", "left", "right", "inner",
			"outer", "on", "and", "or", "not", "null", "is", "as", "order", "by", "group",
			"having", "limit", "offset", "distinct", "primary", "key", "foreign", "references",
		),
	)

	val MARKUP = Language(
		"markup", "HTML / XML", LexerKind.MARKUP,
		extensions = setOf("html", "htm", "xhtml", "xml", "svg", "vue", "svelte", "xsl", "plist"),
		blockComment = "<!--" to "-->",
	)

	val MARKDOWN = Language(
		"markdown", "Markdown", LexerKind.MARKDOWN,
		extensions = setOf("md", "markdown", "mdx"),
		blockComment = "<!--" to "-->",
	)

	val ALL: List<Language> = listOf(
		PLAIN, JAVASCRIPT, JSON, CSS, PYTHON, KOTLIN_JAVA, C_FAMILY, SHELL, SQL, MARKUP, MARKDOWN,
	)

	/** Picks a language from a file name, falling back to [PLAIN]. */
	fun forFileName(fileName: String?): Language {
		if (fileName.isNullOrBlank()) return PLAIN
		val name = fileName.substringAfterLast('/').lowercase()
		ALL.firstOrNull { name in it.fileNames }?.let { return it }
		val extension = name.substringAfterLast('.', missingDelimiterValue = "")
		if (extension.isEmpty()) return PLAIN
		return ALL.firstOrNull { extension in it.extensions } ?: PLAIN
	}

	fun byId(id: String?): Language = ALL.firstOrNull { it.id == id } ?: PLAIN
}
