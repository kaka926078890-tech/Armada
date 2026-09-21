package app.armada.remote

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

val PlanYellow = Color(0xFFF1B467)
val IosGroupedLight = Color(0xFFF2F2F7)
val IosGroupedDark = Color(0xFF000000)
val IosCellLight = Color(0xFFFFFFFF)
val IosCellDark = Color(0xFF1C1C1E)

data class IosPalette(
    val accent: Color,
    val green: Color,
    val red: Color,
    val blue: Color,
    val gray: Color,
    val orange: Color,
    val page: Color,
    val grouped: Color,
    val cell: Color,
    val secondary: Color,
)

fun iosPalette(dark: Boolean): IosPalette {
    val a = iosPaletteArgb(dark)
    fun c(v: Long) = Color(v)
    return IosPalette(
        accent = c(a.accent),
        green = c(a.green),
        red = c(a.red),
        blue = c(a.blue),
        gray = c(a.gray),
        orange = c(a.orange),
        page = c(a.page),
        grouped = c(a.grouped),
        cell = c(a.cell),
        secondary = c(a.secondary),
    )
}

val LocalIosPalette = compositionLocalOf { iosPalette(true) }
val LocalIosFill = compositionLocalOf { Color(0x51787880) }

val AccentBlue: Color @Composable get() = LocalIosPalette.current.accent
val StatusGreen: Color @Composable get() = LocalIosPalette.current.green
val StatusRed: Color @Composable get() = LocalIosPalette.current.red
val StatusBlue: Color @Composable get() = LocalIosPalette.current.blue
val StatusGray: Color @Composable get() = LocalIosPalette.current.gray
val StatusOrange: Color @Composable get() = LocalIosPalette.current.orange

fun iosFill(dark: Boolean) = if (dark) Color(0x51787880) else Color(0x33787880)

fun armadaColorScheme(dark: Boolean): androidx.compose.material3.ColorScheme {
    val p = iosPalette(dark)
    return if (dark) {
        darkColorScheme(
            primary = p.accent,
            onPrimary = Color.White,
            secondary = p.accent,
            onSecondary = Color.White,
            tertiary = p.accent,
            background = p.grouped,
            onBackground = Color(0xFFF2F2F7),
            surface = p.cell,
            onSurface = Color(0xFFF2F2F7),
            surfaceVariant = Color(0xFF2C2C2E),
            onSurfaceVariant = Color(0xFF8E8E93),
            outline = Color(0xFF3A3A3C),
            error = p.red,
        )
    } else {
        lightColorScheme(
            primary = p.accent,
            onPrimary = Color.White,
            secondary = p.accent,
            onSecondary = Color.White,
            tertiary = p.accent,
            background = p.grouped,
            onBackground = Color(0xFF000000),
            surface = p.cell,
            onSurface = Color(0xFF000000),
            surfaceVariant = Color(0xFFE5E5EA),
            onSurfaceVariant = Color(0xFF8E8E93),
            outline = Color(0xFFC6C6C8),
            error = p.red,
        )
    }
}

@Composable
fun statusColor(status: String) = when (statusTint(status)) {
    "green" -> StatusGreen
    "blue" -> StatusBlue
    "red" -> StatusRed
    "gray" -> StatusGray
    else -> StatusOrange
}

data class NavAction(val title: String, val enabled: Boolean = true, val onClick: () -> Unit)

data class SwipeAction(val label: String, val color: Color, val onClick: () -> Unit)

enum class IosIcon { Mic, Stop, ArrowUp, Copy, Unread, Eye, EyeSlash, Check, Hourglass, Photo }

@Composable
fun IosNavBar(
    title: String,
    leading: NavAction? = null,
    trailing: List<NavAction> = emptyList(),
    largeTitle: Boolean = false,
) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(46.dp)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (leading != null) {
                    Text(
                        leading.title,
                        color = if (leading.enabled) AccentBlue else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
                        modifier = Modifier
                            .clickable(enabled = leading.enabled, onClick = leading.onClick)
                            .padding(horizontal = 8.dp, vertical = 10.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (!largeTitle) {
                Text(
                    title,
                    modifier = Modifier.weight(1.6f),
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            } else {
                Spacer(Modifier.weight(0.2f))
            }
            Row(
                Modifier.weight(1f),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                trailing.forEach { action ->
                    Text(
                        action.title,
                        color = if (action.enabled) AccentBlue else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
                        modifier = Modifier
                            .clickable(enabled = action.enabled, onClick = action.onClick)
                            .padding(horizontal = 8.dp, vertical = 10.dp),
                        maxLines = 1,
                    )
                }
            }
        }
        if (largeTitle) {
            Text(
                title,
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun GroupedSection(
    header: String? = null,
    modifier: Modifier = Modifier,
    headerLeading: @Composable (() -> Unit)? = null,
    headerTrailing: @Composable (() -> Unit)? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (header != null || headerLeading != null || headerTrailing != null) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                headerLeading?.invoke()
                if (header != null) {
                    Text(
                        header,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
                headerTrailing?.invoke()
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surface),
            content = content,
        )
        if (footer != null) {
            Text(
                footer,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
fun GroupedDivider() {
    HorizontalDivider(
        Modifier.padding(start = 16.dp),
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
    )
}

@Composable
fun IosTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    minLines: Int = 1,
    maxLines: Int = 8,
    readOnly: Boolean = false,
) {
    val style = TextStyle(
        color = MaterialTheme.colorScheme.onSurface,
        fontSize = 17.sp,
        lineHeight = 22.sp,
    )
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        enabled = !readOnly,
        textStyle = style,
        minLines = minLines,
        maxLines = maxLines,
        cursorBrush = SolidColor(AccentBlue),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) {
                    Text(placeholder, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 17.sp)
                }
                inner()
            }
        },
    )
}

@Composable
fun BarButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    filled: Boolean = false,
    danger: Boolean = false,
    compact: Boolean = false,
    expand: Boolean = false,
    fillColor: Color? = null,
    textColor: Color? = null,
    onClick: () -> Unit,
) {
    val fg = textColor ?: when {
        danger || filled -> Color.White
        else -> MaterialTheme.colorScheme.onSurface
    }
    val bg = fillColor ?: when {
        danger -> StatusRed
        filled -> AccentBlue
        else -> LocalIosFill.current
    }
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .then(if (expand) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = if (compact) 32.dp else 36.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .background(bg)
            .then(
                if (!filled && !danger) Modifier.border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.18f), shape)
                else Modifier,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = if (compact) 12.dp else 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = fg, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ComposerBar(
    value: String,
    onValueChange: (String) -> Unit,
    sending: Boolean,
    listening: Boolean,
    canSend: Boolean,
    enabledMic: Boolean,
    onMic: () -> Unit,
    onSend: () -> Unit,
    photoVisible: Boolean = false,
    photoEnabled: Boolean = true,
    onPhoto: () -> Unit = {},
    onPhotoLong: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(32.dp)
                .alpha(if (enabledMic) 1f else 0.4f)
                .clickable(enabled = enabledMic, onClick = onMic),
            contentAlignment = Alignment.Center,
        ) {
            IosGlyph(if (listening) IosIcon.Stop else IosIcon.Mic, Modifier.size(22.dp), MaterialTheme.colorScheme.onSurface)
        }
        if (photoVisible) {
            Box(
                Modifier
                    .size(32.dp)
                    .alpha(if (photoEnabled) 1f else 0.4f)
                    .combinedClickable(
                        onClick = { if (photoEnabled) onPhoto() else onPhoto() },
                        onLongClick = { onPhotoLong?.invoke() },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                IosGlyph(IosIcon.Photo, Modifier.size(22.dp), MaterialTheme.colorScheme.onSurface)
            }
        }
        Box(
            Modifier
                .weight(1f)
                .heightIn(min = 36.dp, max = 144.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(LocalIosFill.current)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            IosTextField(
                value = value,
                onValueChange = onValueChange,
                placeholder = "输入提示词",
                modifier = Modifier.fillMaxWidth(),
                minLines = 1,
                maxLines = 6,
                readOnly = listening || sending,
            )
        }
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(if (canSend) AccentBlue else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            IosGlyph(if (sending) IosIcon.Hourglass else IosIcon.ArrowUp, Modifier.size(16.dp), Color.White)
        }
    }
}

@Composable
fun UnreadBadge(count: Int) {
    val label = unreadBadgeText(count) ?: return
    Box(
        Modifier
            .heightIn(min = 18.dp)
            .clip(RoundedCornerShape(50))
            .background(StatusRed)
            .padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun SwipeActionRow(
    leading: SwipeAction? = null,
    trailing: List<SwipeAction> = emptyList(),
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val offset = remember { Animatable(0f) }
    val actionW = 88.dp
    Box(modifier.fillMaxWidth().clip(RoundedCornerShape(0.dp))) {
        Row(Modifier.matchParentSize()) {
            if (leading != null) {
                Box(
                    Modifier.width(actionW).fillMaxHeight().background(leading.color).clickable {
                        scope.launch { offset.animateTo(0f, tween(160)) }
                        leading.onClick()
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(leading.label, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.weight(1f))
            trailing.forEach { action ->
                Box(
                    Modifier.width(actionW).fillMaxHeight().background(action.color).clickable {
                        scope.launch { offset.animateTo(0f, tween(160)) }
                        action.onClick()
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(action.label, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .pointerInput(leading, trailing) {
                    val wPx = actionW.toPx()
                    val min = if (trailing.isNotEmpty()) -wPx * trailing.size else 0f
                    val max = if (leading != null) wPx else 0f
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                val fullSwipe = trailing.isNotEmpty() && offset.value <= min + 12f
                                if (fullSwipe) {
                                    trailing.last().onClick()
                                    offset.animateTo(0f, tween(160))
                                    return@launch
                                }
                                val target = when {
                                    offset.value > wPx / 2f -> max
                                    offset.value < -wPx / 2f -> min
                                    else -> 0f
                                }
                                offset.animateTo(target, tween(160))
                            }
                        },
                    ) { change, drag ->
                        change.consume()
                        scope.launch { offset.snapTo((offset.value + drag).coerceIn(min, max)) }
                    }
                },
        ) { content() }
    }
}

@Composable
fun DetailActionBar(
    copy: () -> Unit,
    copied: Boolean,
    unread: (() -> Unit)?,
    hide: (() -> Unit)?,
    hideTitle: String,
) {
    val items = buildList {
        add(Triple(if (copied) "已复制" else "复制正文", if (copied) IosIcon.Check else IosIcon.Copy, copy))
        if (unread != null) add(Triple("标为未读", IosIcon.Unread, unread))
        if (hide != null) add(Triple(hideTitle, if (hideTitle == "取消隐藏") IosIcon.Eye else IosIcon.EyeSlash, hide))
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(LocalIosFill.current)
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEachIndexed { index, (title, icon, action) ->
            if (index > 0) {
                Box(Modifier.width(1.dp).height(28.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f)))
            }
            Column(
                Modifier.weight(1f).heightIn(min = 52.dp).clickable(onClick = action),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                IosGlyph(icon, Modifier.size(22.dp), AccentBlue)
                Spacer(Modifier.height(5.dp))
                Text(title, color = AccentBlue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
        }
    }
}

@Composable
fun IosGlyph(icon: IosIcon, modifier: Modifier = Modifier, tint: Color = AccentBlue) {
    Canvas(modifier) {
        val stroke = Stroke(width = size.minDimension * 0.08f, cap = StrokeCap.Round)
        val c = tint
        val w = size.width
        val h = size.height
        when (icon) {
            IosIcon.Mic -> {
                drawRoundRect(
                    color = c,
                    topLeft = androidx.compose.ui.geometry.Offset(w * 0.36f, h * 0.12f),
                    size = androidx.compose.ui.geometry.Size(w * 0.28f, h * 0.46f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.14f, w * 0.14f),
                )
                drawArc(
                    color = c,
                    startAngle = 20f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = androidx.compose.ui.geometry.Offset(w * 0.22f, h * 0.28f),
                    size = androidx.compose.ui.geometry.Size(w * 0.56f, h * 0.42f),
                    style = stroke,
                )
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.70f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.82f), strokeWidth = stroke.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.34f, h * 0.84f), androidx.compose.ui.geometry.Offset(w * 0.66f, h * 0.84f), strokeWidth = stroke.width, cap = StrokeCap.Round)
            }
            IosIcon.Stop -> {
                drawRoundRect(
                    color = c,
                    topLeft = androidx.compose.ui.geometry.Offset(w * 0.28f, h * 0.28f),
                    size = androidx.compose.ui.geometry.Size(w * 0.44f, h * 0.44f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.06f, w * 0.06f),
                )
            }
            IosIcon.ArrowUp -> {
                val path = Path().apply {
                    moveTo(w * 0.5f, h * 0.22f)
                    lineTo(w * 0.22f, h * 0.52f)
                    moveTo(w * 0.5f, h * 0.22f)
                    lineTo(w * 0.78f, h * 0.52f)
                    moveTo(w * 0.5f, h * 0.22f)
                    lineTo(w * 0.5f, h * 0.78f)
                }
                drawPath(path, c, style = stroke)
            }
            IosIcon.Copy -> {
                drawRoundRect(c, androidx.compose.ui.geometry.Offset(w * 0.32f, h * 0.18f), androidx.compose.ui.geometry.Size(w * 0.46f, h * 0.52f), androidx.compose.ui.geometry.CornerRadius(w * 0.06f), style = stroke)
                drawRoundRect(c, androidx.compose.ui.geometry.Offset(w * 0.18f, h * 0.32f), androidx.compose.ui.geometry.Size(w * 0.46f, h * 0.52f), androidx.compose.ui.geometry.CornerRadius(w * 0.06f), style = stroke)
            }
            IosIcon.Unread -> {
                drawRoundRect(c, androidx.compose.ui.geometry.Offset(w * 0.16f, h * 0.28f), androidx.compose.ui.geometry.Size(w * 0.68f, h * 0.46f), androidx.compose.ui.geometry.CornerRadius(w * 0.08f), style = stroke)
                val flap = Path().apply {
                    moveTo(w * 0.16f, h * 0.32f)
                    lineTo(w * 0.5f, h * 0.54f)
                    lineTo(w * 0.84f, h * 0.32f)
                }
                drawPath(flap, c, style = stroke)
                drawCircle(c, radius = w * 0.08f, center = androidx.compose.ui.geometry.Offset(w * 0.78f, h * 0.24f))
            }
            IosIcon.Eye -> {
                drawArc(c, 200f, 140f, false, androidx.compose.ui.geometry.Offset(w * 0.12f, h * 0.28f), androidx.compose.ui.geometry.Size(w * 0.76f, h * 0.44f), style = stroke)
                drawArc(c, 20f, 140f, false, androidx.compose.ui.geometry.Offset(w * 0.12f, h * 0.28f), androidx.compose.ui.geometry.Size(w * 0.76f, h * 0.44f), style = stroke)
                drawCircle(c, radius = w * 0.1f, center = androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f))
            }
            IosIcon.EyeSlash -> {
                drawArc(c, 200f, 140f, false, androidx.compose.ui.geometry.Offset(w * 0.12f, h * 0.28f), androidx.compose.ui.geometry.Size(w * 0.76f, h * 0.44f), style = stroke)
                drawArc(c, 20f, 140f, false, androidx.compose.ui.geometry.Offset(w * 0.12f, h * 0.28f), androidx.compose.ui.geometry.Size(w * 0.76f, h * 0.44f), style = stroke)
                drawCircle(c, radius = w * 0.1f, center = androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f))
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.18f, h * 0.82f), androidx.compose.ui.geometry.Offset(w * 0.82f, h * 0.18f), strokeWidth = stroke.width, cap = StrokeCap.Round)
            }
            IosIcon.Hourglass -> {
                val hs = Stroke(width = stroke.width, cap = StrokeCap.Round, join = StrokeJoin.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.28f, h * 0.16f), androidx.compose.ui.geometry.Offset(w * 0.72f, h * 0.16f), strokeWidth = hs.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.28f, h * 0.84f), androidx.compose.ui.geometry.Offset(w * 0.72f, h * 0.84f), strokeWidth = hs.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.32f, h * 0.16f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f), strokeWidth = hs.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.68f, h * 0.16f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f), strokeWidth = hs.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.32f, h * 0.84f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f), strokeWidth = hs.width, cap = StrokeCap.Round)
                drawLine(c, androidx.compose.ui.geometry.Offset(w * 0.68f, h * 0.84f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.5f), strokeWidth = hs.width, cap = StrokeCap.Round)
            }
            IosIcon.Check -> {
                val path = Path().apply {
                    moveTo(w * 0.22f, h * 0.52f)
                    lineTo(w * 0.42f, h * 0.72f)
                    lineTo(w * 0.78f, h * 0.28f)
                }
                drawPath(path, c, style = stroke)
            }
            IosIcon.Photo -> {
                drawRoundRect(
                    c,
                    androidx.compose.ui.geometry.Offset(w * 0.14f, h * 0.22f),
                    androidx.compose.ui.geometry.Size(w * 0.72f, h * 0.56f),
                    androidx.compose.ui.geometry.CornerRadius(w * 0.08f),
                    style = stroke,
                )
                drawCircle(c, radius = w * 0.08f, center = androidx.compose.ui.geometry.Offset(w * 0.34f, h * 0.40f))
                val mountain = Path().apply {
                    moveTo(w * 0.22f, h * 0.68f)
                    lineTo(w * 0.42f, h * 0.48f)
                    lineTo(w * 0.56f, h * 0.60f)
                    lineTo(w * 0.70f, h * 0.44f)
                    lineTo(w * 0.82f, h * 0.68f)
                }
                drawPath(mountain, c, style = stroke)
            }
        }
    }
}
