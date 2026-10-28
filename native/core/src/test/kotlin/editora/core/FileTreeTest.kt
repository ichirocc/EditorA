package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FileTreeTest {
	private fun dir(id: String) = TreeEntry(id, id.substringAfterLast('/'), isDirectory = true)
	private fun file(id: String) = TreeEntry(id, id.substringAfterLast('/'), isDirectory = false)

	private fun FileTree.names() = rows().map { "  ".repeat(it.depth) + it.entry.name + if (it.loading) "…" else "" }

	@Test
	fun foldersFirstThenCaseInsensitiveNames() {
		val tree = FileTree("root")
		tree.setChildren("root", listOf(file("root/b.txt"), dir("root/src"), file("root/A.md"), dir("root/Docs")))
		assertEquals(listOf("Docs", "src", "A.md", "b.txt"), tree.names())
	}

	@Test
	fun expandLoadsLazilyAndCollapseHides() {
		val tree = FileTree("root")
		tree.setChildren("root", listOf(dir("root/src"), file("root/x")))
		assertTrue(tree.toggle("root/src"))
		assertEquals(listOf("src…", "x"), tree.names())
		assertEquals(listOf("root/src"), tree.pendingLoads())

		tree.setChildren("root/src", listOf(file("root/src/main.kt")))
		assertEquals(listOf("src", "  main.kt", "x"), tree.names())

		assertFalse(tree.toggle("root/src"))
		assertEquals(listOf("src", "x"), tree.names())

		// Re-expanding uses the cached children.
		assertFalse(tree.toggle("root/src"))
		assertEquals(listOf("src", "  main.kt", "x"), tree.names())
	}

	@Test
	fun rowsCarryParentAndDepth() {
		val tree = FileTree("root")
		tree.setChildren("root", listOf(dir("root/a")))
		tree.toggle("root/a")
		tree.setChildren("root/a", listOf(file("root/a/f")))
		val row = tree.rows().last()
		assertEquals("root/a", row.parentId)
		assertEquals(1, row.depth)
	}

	@Test
	fun restoredExpansionReportsPendingLoadsInOrder() {
		val tree = FileTree("root")
		tree.expand(listOf("root/a", "root/a/b"))
		assertEquals(listOf("root"), tree.pendingLoads())
		tree.setChildren("root", listOf(dir("root/a")))
		assertEquals(listOf("root/a"), tree.pendingLoads())
		tree.setChildren("root/a", listOf(dir("root/a/b")))
		assertEquals(listOf("root/a/b"), tree.pendingLoads())
	}

	@Test
	fun invalidateForcesReload() {
		val tree = FileTree("root")
		tree.setChildren("root", listOf(file("root/x")))
		tree.invalidate("root")
		assertFalse(tree.isLoaded("root"))
		assertEquals(listOf("root"), tree.pendingLoads())
	}

	@Test
	fun selfContainingFolderDoesNotLoopForever() {
		val tree = FileTree("root")
		tree.setChildren("root", listOf(dir("loop")))
		tree.toggle("loop")
		tree.setChildren("loop", listOf(dir("loop")))
		assertEquals(listOf("loop", "  loop"), tree.names())
	}
}
