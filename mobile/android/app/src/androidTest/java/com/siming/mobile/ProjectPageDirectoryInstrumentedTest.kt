package com.siming.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import com.siming.mobile.ui.ProjectPageDirectory
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Pure navigation component: no application database or author content is opened. */
class ProjectPageDirectoryInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun searchFindsCatalogingAndRecycleAtLargeSystemFont() {
        var selected = ""
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.45f)) {
                MaterialTheme { ProjectPageDirectory(onDismiss = {}, onSelected = { selected = it }) }
            }
        }
        compose.onNodeWithText("全部页面").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("建档")
        compose.waitForIdle()
        compose.onNodeWithText("建档与导出").performScrollTo().assertIsDisplayed().performClick()
        assertEquals("tools", selected)
        compose.onNode(hasSetTextAction()).performTextReplacement("回收站")
        compose.onNode(hasText("回收站") and hasClickAction() and !hasSetTextAction()).performScrollTo().assertIsDisplayed().performClick()
        assertEquals("recycle", selected)
    }
}
