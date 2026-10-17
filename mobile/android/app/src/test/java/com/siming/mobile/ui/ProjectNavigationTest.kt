package com.siming.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectNavigationTest {
    @Test fun `all pages can be found by their visible page names`() {
        assertEquals(projectPages.size, projectPages.map { it.key }.distinct().size)
        assertEquals(listOf("tools"), searchProjectPages("建档").map { it.key })
        assertEquals(listOf("world"), searchProjectPages("世界观").map { it.key })
        assertEquals(listOf("recycle"), searchProjectPages("回收站").map { it.key })
        assertEquals(projectPages, searchProjectPages(""))
    }
    @Test
    fun `reference sections share one primary destination`() {
        listOf("reference", "character", "world", "foreshadowing", "governance", "tools").forEach { section ->
            assertEquals("reference", projectPrimaryKey(section))
        }
    }

    @Test
    fun `writing outline and assistant keep dedicated destinations`() {
        assertEquals("chapter", projectPrimaryKey("chapter"))
        assertEquals("assistant", projectPrimaryKey("assistant"))
        assertEquals("outline", projectPrimaryKey("outline"))
    }
}
