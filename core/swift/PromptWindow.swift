// answer-card —— macOS 悬浮窗核心助手（AppKit）。
//
// 由宿主适配层（Antigravity / DSH / Zed）以 stdin 传入一份 JSON 载荷启动，
// 画一张置顶、无边框、深色圆角的卡片，等用户操作后把结果用一行 JSON 写回 stdout 并退出。
//
// 载荷：
//   { kind, kicker, title, subtitle, message,
//     groups:[{id,text,detail,multi,input,optional,placeholder,choices:[{id,label,hint}]}],
//     submit, dismiss, accent, position, width, fontScale, sound, autoDismissMs, allowText }
// 结果：
//   {"result":"choose","answers":{"<groupId>":["<choiceId>", ...]},"texts":{"<groupId>":"..."}}
//   {"result":"dismiss"}
//   {"result":"timeout"}
//
// 附加子命令：
//   --probe                                        打印当前前台 app 的 bundleId 与名称
//   --screens                                      打印屏幕与鼠标坐标（诊断用）
//   --activate <bundleIds> [--name <names>] [--warp] 激活宿主应用并可选挪动鼠标指针

import AppKit
import ApplicationServices
import Foundation

// MARK: - 载荷

struct Choice: Decodable {
    let id: String
    let label: String
    let hint: String?
}

struct Group: Decodable {
    let id: String
    let text: String
    let detail: String?
    let multi: Bool?
    let input: Bool?
    let optional: Bool?
    let placeholder: String?
    let choices: [Choice]
}

struct ThemeColors: Decodable {
    let mode: String?
    let background: String?
    let surface: String?
    let border: String?
    let textPrimary: String?
    let textSecondary: String?
}

struct Payload: Decodable {
    let kind: String
    let kicker: String?
    let title: String
    let subtitle: String?
    let message: String?
    let groups: [Group]?
    let submit: String?
    /// 输入框有内容时主按钮动态显示的文案（例如「发送到 Antigravity」）。
    let submitWhenTyped: String?
    let dismiss: String?
    let accent: String?
    let theme: ThemeColors?
    let position: String?
    let width: Double?
    let fontScale: Double?
    let sound: Bool?
    let autoDismissMs: Int?
    /// 带选项的问题也允许自由输入（作为 custom 回传）。
    let allowText: Bool?
}

// MARK: - 小工具

func color(_ hex: String?, fallback: NSColor = NSColor(srgbRed: 0.30, green: 0.42, blue: 0.99, alpha: 1), alpha: CGFloat = 1) -> NSColor {
    guard let hex else { return fallback.withAlphaComponent(alpha) }
    var value: UInt64 = 0
    var text = hex.replacingOccurrences(of: "#", with: "")
    if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
    guard Scanner(string: text).scanHexInt64(&value) else {
        return fallback.withAlphaComponent(alpha)
    }
    return NSColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
        green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255,
        alpha: alpha
    )
}

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func isLightColor(_ nsColor: NSColor) -> Bool {
    guard let srgb = nsColor.usingColorSpace(.sRGB) else { return false }
    let lum = 0.2126 * srgb.redComponent + 0.7152 * srgb.greenComponent + 0.0722 * srgb.blueComponent
    return lum > 0.55
}

func systemIsLight() -> Bool {
    if let app = NSApp {
        let match = app.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
        return match == .aqua
    }
    return UserDefaults.standard.string(forKey: "AppleInterfaceStyle")?.lowercased() != "dark"
}

func flagValue(_ flag: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    let value = args[index + 1]
    return value.hasPrefix("--") ? nil : value
}

func measureAttributed(_ attr: NSAttributedString, width: CGFloat) -> CGFloat {
    let rect = attr.boundingRect(
        with: NSSize(width: width, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading]
    )
    return ceil(rect.height) + 2
}

/// 轻量 Markdown 渲染：支持标题、无序列表、**加粗**、*斜体*、`行内代码` 与 [链接](url)。
func renderMarkdown(
    _ raw: String,
    fontSize: CGFloat,
    baseWeight: NSFont.Weight = .regular,
    textColor: NSColor,
    secondaryColor: NSColor,
    codeBg: NSColor,
    accentColor: NSColor,
    lineSpacing: CGFloat = 4
) -> NSAttributedString {
    let result = NSMutableAttributedString()
    let lines = raw.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    let inlinePattern = try? NSRegularExpression(
        pattern: #"(``[^`\n]*(?:`[^`\n]+`[^`\n]*)*``|`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\[[^\]\n]+\]\([^)\n]+\)|(?<!\*)\*[^*\n]+?\*(?!\*))"#
    )

    for (lineIdx, originalLine) in lines.enumerated() {
        var line = originalLine
        var isHeading = false
        var isBullet = false

        // 处理 ### 标题
        if let range = line.range(of: #"^\s*#{1,6}\s+"#, options: .regularExpression) {
            line.removeSubrange(range)
            isHeading = true
        } else if let range = line.range(of: #"^\s*[-*•]\s+"#, options: .regularExpression) {
            line.removeSubrange(range)
            isBullet = true
        }

        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byWordWrapping
        para.lineSpacing = lineSpacing
        para.paragraphSpacing = isHeading ? 4 : 3
        if isBullet {
            para.firstLineHeadIndent = 0
            para.headIndent = 14
        }

        let lineSize = isHeading ? fontSize + 1.2 : fontSize
        let lineWeight: NSFont.Weight = isHeading ? .semibold : baseWeight
        let baseFont = NSFont.systemFont(ofSize: lineSize, weight: lineWeight)
        let boldFont = NSFont.systemFont(ofSize: lineSize, weight: .semibold)
        let italicFont = NSFontManager.shared.convert(baseFont, toHaveTrait: .italicFontMask)
        let codeFont = NSFont.monospacedSystemFont(ofSize: max(10, lineSize - 1), weight: .regular)

        let baseAttrs: [NSAttributedString.Key: Any] = [
            .font: baseFont,
            .foregroundColor: textColor,
            .paragraphStyle: para,
        ]

        let lineAttr = NSMutableAttributedString()
        if isBullet {
            lineAttr.append(NSAttributedString(string: "•  ", attributes: [
                .font: boldFont,
                .foregroundColor: accentColor,
                .paragraphStyle: para,
            ]))
        }

        if let regex = inlinePattern {
            let nsLine = line as NSString
            let matches = regex.matches(in: line, range: NSRange(location: 0, length: nsLine.length))
            var cursor = 0
            for match in matches {
                if match.range.location > cursor {
                    let plain = nsLine.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                    lineAttr.append(NSAttributedString(string: plain, attributes: baseAttrs))
                }
                let token = nsLine.substring(with: match.range)
                if token.hasPrefix("``"), token.hasSuffix("``"), token.count >= 4 {
                    var inner = String(token.dropFirst(2).dropLast(2))
                    if inner.hasPrefix(" "), inner.hasSuffix(" "), inner.count >= 2 {
                        inner = String(inner.dropFirst().dropLast())
                    }
                    lineAttr.append(NSAttributedString(string: " \(inner) ", attributes: [
                        .font: codeFont,
                        .foregroundColor: textColor,
                        .backgroundColor: codeBg,
                        .paragraphStyle: para,
                    ]))
                } else if token.hasPrefix("`"), token.hasSuffix("`"), token.count >= 2 {
                    let inner = String(token.dropFirst().dropLast())
                    lineAttr.append(NSAttributedString(string: " \(inner) ", attributes: [
                        .font: codeFont,
                        .foregroundColor: textColor,
                        .backgroundColor: codeBg,
                        .paragraphStyle: para,
                    ]))
                } else if (token.hasPrefix("**") && token.hasSuffix("**")) || (token.hasPrefix("__") && token.hasSuffix("__")), token.count >= 4 {
                    let inner = String(token.dropFirst(2).dropLast(2))
                    lineAttr.append(NSAttributedString(string: inner, attributes: [
                        .font: boldFont,
                        .foregroundColor: textColor,
                        .paragraphStyle: para,
                    ]))
                } else if token.hasPrefix("["), let sep = token.range(of: "]("), token.hasSuffix(")") {
                    let linkText = String(token[token.index(after: token.startIndex)..<sep.lowerBound])
                    let urlStart = sep.upperBound
                    let urlEnd = token.index(before: token.endIndex)
                    let urlStr = String(token[urlStart..<urlEnd])
                    var attrs: [NSAttributedString.Key: Any] = [
                        .font: NSFont.systemFont(ofSize: lineSize, weight: .medium),
                        .foregroundColor: accentColor,
                        .underlineStyle: NSUnderlineStyle.single.rawValue,
                        .paragraphStyle: para,
                    ]
                    if let url = URL(string: urlStr), url.scheme == "http" || url.scheme == "https" || url.scheme == "file" {
                        attrs[.link] = url
                    }
                    lineAttr.append(NSAttributedString(string: linkText, attributes: attrs))
                } else if token.hasPrefix("*"), token.hasSuffix("*"), token.count >= 2 {
                    let inner = String(token.dropFirst().dropLast())
                    lineAttr.append(NSAttributedString(string: inner, attributes: [
                        .font: italicFont,
                        .foregroundColor: secondaryColor,
                        .paragraphStyle: para,
                    ]))
                } else {
                    lineAttr.append(NSAttributedString(string: token, attributes: baseAttrs))
                }
                cursor = match.range.location + match.range.length
            }
            if cursor < nsLine.length {
                lineAttr.append(NSAttributedString(string: nsLine.substring(from: cursor), attributes: baseAttrs))
            }
        } else {
            lineAttr.append(NSAttributedString(string: line, attributes: baseAttrs))
        }

        if lineIdx < lines.count - 1 {
            lineAttr.append(NSAttributedString(string: "\n", attributes: baseAttrs))
        }
        result.append(lineAttr)
    }

    return result
}

func attributedLabel(_ attr: NSAttributedString, width: CGFloat, lines: Int = 0) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: "")
    field.allowsEditingTextAttributes = true
    field.attributedStringValue = attr
    field.isSelectable = true
    field.isEditable = false
    field.drawsBackground = false
    field.isBezeled = false
    field.maximumNumberOfLines = lines
    field.lineBreakMode = .byWordWrapping
    field.preferredMaxLayoutWidth = width
    field.frame = NSRect(x: 0, y: 0, width: width, height: measureAttributed(attr, width: width))
    return field
}

func measure(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
    let rect = (text as NSString).boundingRect(
        with: NSSize(width: width, height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        attributes: attributes
    )
    return ceil(rect.height) + 2
}

func label(
    _ text: String,
    font: NSFont,
    color: NSColor,
    width: CGFloat,
    lines: Int = 0
) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = font
    field.textColor = color
    field.isSelectable = true
    field.isEditable = false
    field.drawsBackground = false
    field.isBezeled = false
    field.maximumNumberOfLines = lines
    field.lineBreakMode = .byWordWrapping
    field.preferredMaxLayoutWidth = width
    field.frame = NSRect(x: 0, y: 0, width: width, height: measure(text, font: font, width: width))
    return field
}

// MARK: - 控件

/// 点击穿透的占位提示标签，绝不抢占下方输入框的鼠标点击。
final class PassthroughLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// 多行自动换行输入框：支持滚动、内边距、placeholder、快捷键编号与 Cmd+Return 快捷提交。
final class MultiLineInputView: NSView, NSTextViewDelegate {
    override var isFlipped: Bool { true }
    let scrollView: NSScrollView
    let textView: NSTextView
    private let placeholderField: PassthroughLabel
    private let hotkeyBadge: PassthroughLabel?
    var onChange: (() -> Void)?
    var onFocus: (() -> Void)?

    var stringValue: String { textView.string }

    init(
        frame: NSRect,
        placeholder: String,
        hotkey: Int? = nil,
        font: NSFont,
        textColor: NSColor,
        secondaryColor: NSColor,
        surfaceColor: NSColor,
        borderColor: NSColor,
        accentColor: NSColor
    ) {
        scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: frame.width, height: frame.height))
        textView = NSTextView(frame: NSRect(x: 0, y: 0, width: frame.width, height: frame.height))
        placeholderField = PassthroughLabel(labelWithString: placeholder)
        if let hotkey {
            hotkeyBadge = PassthroughLabel(labelWithString: "\(hotkey)")
        } else {
            hotkeyBadge = nil
        }
        super.init(frame: frame)

        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        layer?.borderColor = borderColor.cgColor
        layer?.backgroundColor = surfaceColor.cgColor
        layer?.masksToBounds = true

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.autoresizingMask = [.width, .height]

        let para = NSMutableParagraphStyle()
        para.lineSpacing = 3
        textView.minSize = NSSize(width: 0, height: frame.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: frame.width - 16, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 8, height: 10)
        textView.drawsBackground = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.font = font
        textView.textColor = textColor
        textView.insertionPointColor = accentColor
        textView.defaultParagraphStyle = para
        textView.typingAttributes = [
            .font: font,
            .foregroundColor: textColor,
            .paragraphStyle: para,
        ]
        textView.delegate = self

        scrollView.documentView = textView
        addSubview(scrollView)

        let badgeReserve: CGFloat = hotkeyBadge != nil ? 30 : 0
        placeholderField.font = font
        placeholderField.textColor = secondaryColor.withAlphaComponent(0.85)
        placeholderField.drawsBackground = false
        placeholderField.isBezeled = false
        placeholderField.isEditable = false
        placeholderField.isSelectable = false
        placeholderField.lineBreakMode = .byTruncatingTail
        placeholderField.frame = NSRect(x: 13, y: 10, width: max(40, frame.width - 26 - badgeReserve), height: ceil(font.pointSize + 6))
        addSubview(placeholderField)

        if let badge = hotkeyBadge {
            badge.font = NSFont.monospacedSystemFont(ofSize: max(10, font.pointSize - 2), weight: .medium)
            badge.textColor = secondaryColor.withAlphaComponent(0.9)
            badge.alignment = .center
            badge.drawsBackground = false
            badge.isBezeled = false
            badge.isEditable = false
            badge.isSelectable = false
            badge.wantsLayer = true
            badge.layer?.cornerRadius = 4
            badge.layer?.borderWidth = 1
            badge.layer?.borderColor = borderColor.cgColor
            badge.frame = NSRect(x: frame.width - 28, y: 8, width: 20, height: 18)
            addSubview(badge)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func focusEditor() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(textView)
        onFocus?()
    }

    override func mouseDown(with event: NSEvent) {
        focusEditor()
        super.mouseDown(with: event)
    }

    func textDidChange(_ notification: Notification) {
        let hasText = !textView.string.isEmpty
        placeholderField.isHidden = hasText
        hotkeyBadge?.isHidden = hasText
        onChange?()
    }
}

/// 圆角面板：用于窗口底板。
final class CardView: NSView {
    override var isFlipped: Bool { true }
}

/// 选项按钮：未选中是深灰描边，选中是品牌色描边 + 淡底。
final class PillButton: NSButton {
    var picked = false { didSet { refresh() } }
    var accent = color("#4D6BFE")
    var surfaceColor = NSColor(srgbRed: 0.173, green: 0.173, blue: 0.180, alpha: 1)
    var borderColor = NSColor(srgbRed: 0.227, green: 0.227, blue: 0.235, alpha: 1)
    var onTap: (() -> Void)?

    init(
        _ choice: Choice,
        hotkey: Int? = nil,
        width: CGFloat,
        fontScale: CGFloat,
        accent: NSColor,
        surface: NSColor,
        border: NSColor,
        textPrimary: NSColor,
        textSecondary: NSColor
    ) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: ceil(36 * fontScale)))
        self.accent = accent
        self.surfaceColor = surface
        self.borderColor = border
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        focusRingType = .none
        target = self
        action = #selector(tapped)
        toolTip = choice.hint

        let paragraph = NSMutableParagraphStyle()
        paragraph.firstLineHeadIndent = 12
        paragraph.headIndent = 12
        paragraph.tailIndent = -12
        paragraph.lineBreakMode = .byTruncatingTail
        let prefix = hotkey.map { "\($0)  " } ?? ""
        var title = prefix + choice.label
        if let hint = choice.hint, !hint.isEmpty {
            title += "   " + hint
        }
        let text = NSMutableAttributedString(
            string: title,
            attributes: [
                .foregroundColor: textPrimary,
                .font: NSFont.systemFont(ofSize: 13 * fontScale, weight: .medium),
                .paragraphStyle: paragraph,
            ]
        )
        if !prefix.isEmpty {
            text.addAttribute(
                .foregroundColor,
                value: textSecondary.withAlphaComponent(0.9),
                range: NSRange(location: 0, length: (prefix as NSString).length)
            )
            text.addAttribute(
                .font,
                value: NSFont.monospacedSystemFont(ofSize: 11.5 * fontScale, weight: .medium),
                range: NSRange(location: 0, length: (prefix as NSString).length)
            )
        }
        if let hint = choice.hint, !hint.isEmpty, let range = title.range(of: hint) {
            let location = title.distance(from: title.startIndex, to: range.lowerBound)
            text.addAttribute(
                .foregroundColor,
                value: textSecondary,
                range: NSRange(location: location, length: hint.count)
            )
            text.addAttribute(
                .font,
                value: NSFont.systemFont(ofSize: 11.5 * fontScale, weight: .regular),
                range: NSRange(location: location, length: hint.count)
            )
        }
        attributedTitle = text
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @objc private func tapped() {
        onTap?()
    }

    func refresh() {
        guard let layer else { return }
        let fillAlpha: CGFloat = isLightColor(surfaceColor) ? 0.14 : 0.22
        layer.backgroundColor = (picked
            ? accent.withAlphaComponent(fillAlpha)
            : surfaceColor).cgColor
        layer.borderColor = (picked
            ? accent.withAlphaComponent(0.95)
            : borderColor).cgColor
    }
}

/// 主按钮（品牌色填充）/ 次按钮（描边）。
final class ActionButton: NSButton {
    private let primary: Bool
    private let accentColor: NSColor
    private let fontScale: CGFloat
    private let secondaryTextColor: NSColor

    init(
        title: String,
        primary: Bool,
        accent: NSColor,
        width: CGFloat,
        fontScale: CGFloat,
        borderColor: NSColor = NSColor(srgbRed: 0.29, green: 0.29, blue: 0.31, alpha: 1),
        secondaryTextColor: NSColor = NSColor(srgbRed: 0.78, green: 0.80, blue: 0.82, alpha: 1)
    ) {
        self.primary = primary
        self.accentColor = accent
        self.fontScale = fontScale
        self.secondaryTextColor = secondaryTextColor
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: ceil(34 * fontScale)))
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = primary ? 0 : 1
        focusRingType = .none
        if primary {
            layer?.backgroundColor = accent.cgColor
            layer?.borderColor = accent.cgColor
        } else {
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderColor = borderColor.cgColor
        }
        setLabel(title)
    }

    func setLabel(_ title: String) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let primaryForeground = isLightColor(accentColor)
            ? NSColor(srgbRed: 0.10, green: 0.10, blue: 0.12, alpha: 1)
            : NSColor.white
        attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: primary ? primaryForeground : secondaryTextColor,
                .font: NSFont.systemFont(ofSize: 13 * fontScale, weight: .semibold),
                .paragraphStyle: paragraph,
            ]
        )
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}

/// 无边框窗口，但可以成为 key window，否则按钮收不到第一次点击。
final class CardWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - 控制器

final class CardController: NSObject, NSApplicationDelegate {
    private let payload: Payload
    private var window: CardWindow!
    private enum HotkeyTarget {
        case choice(Group, Choice)
        case input(String)
    }

    private var picks: [String: Set<String>] = [:]
    private var pills: [String: [String: PillButton]] = [:]
    private var textFields: [String: MultiLineInputView] = [:]
    private var draftTexts: [String: String] = [:]
    private var hotkeyTargets: [Int: HotkeyTarget] = [:]
    private var canExpand = false
    private var submitButton: ActionButton?
    private var expanded = false
    private var settled = false

    /// 整体字号缩放，来自设置。
    private var scale: CGFloat { CGFloat(max(0.7, min(1.8, payload.fontScale ?? 1))) }

    /// 拖动状态：按下那一刻的窗口原点与鼠标位置。
    private var dragAnchorOrigin: NSPoint?
    private var dragAnchorMouse: NSPoint?

    private func isInteractiveHit(_ view: NSView?) -> Bool {
        var cur = view
        while let v = cur {
            if v is NSButton || v is NSTextView || v is MultiLineInputView { return true }
            if let tf = v as? NSTextField, tf.isEditable || tf.isSelectable { return true }
            cur = v.superview
        }
        return false
    }

    /// 为 .accessory 进程注册标准 Edit 菜单，否则 ⌘C / ⌘V / ⌘A / ⌘X / ⌘Z 无响应。
    private func installEditMenu() {
        let mainMenu = NSMenu()
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
    }

    private func findInputView(_ view: NSView?) -> MultiLineInputView? {
        var cur = view
        while let v = cur {
            if let input = v as? MultiLineInputView { return input }
            cur = v.superview
        }
        return nil
    }

    /// 卡片除了按钮、链接文本和输入框，其余地方都能拖动。
    private func installDragMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self, self.window != nil else { return event }
            switch event.type {
            case .leftMouseDown:
                let point = self.window.contentView?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
                let hit = self.window.contentView?.hitTest(point)
                if let input = self.findInputView(hit) {
                    self.dragAnchorOrigin = nil
                    self.dragAnchorMouse = nil
                    input.focusEditor()
                } else if self.isInteractiveHit(hit) {
                    self.dragAnchorOrigin = nil
                    self.dragAnchorMouse = nil
                } else {
                    if self.isEditingTextInput() {
                        self.window.makeFirstResponder(nil)
                    }
                    self.dragAnchorOrigin = self.window.frame.origin
                    self.dragAnchorMouse = NSEvent.mouseLocation
                }
            case .leftMouseDragged:
                guard let origin = self.dragAnchorOrigin, let start = self.dragAnchorMouse else { return event }
                let now = NSEvent.mouseLocation
                let moved = NSPoint(x: origin.x + now.x - start.x, y: origin.y + now.y - start.y)
                self.window.setFrameOrigin(self.clamped(moved))
            case .leftMouseUp:
                self.dragAnchorOrigin = nil
                self.dragAnchorMouse = nil
            default:
                break
            }
            return event
        }
    }

    /// 展开/收起时将整张窗口严格限制在当前屏幕可见区内（四边留 8pt，防止溢出屏幕）。
    private func fittedOnScreen(_ origin: NSPoint, forSize size: NSSize) -> NSPoint {
        let center = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
        guard let screen = window?.screen
            ?? NSScreen.screens.first(where: { $0.frame.contains(center) })
            ?? NSScreen.main ?? NSScreen.screens.first else { return origin }
        let area = screen.visibleFrame
        let margin: CGFloat = 8
        let minX = area.minX + margin
        let maxX = max(minX, area.maxX - size.width - margin)
        let minY = area.minY + margin
        let maxY = max(minY, area.maxY - size.height - margin)
        return NSPoint(
            x: min(max(origin.x, minX), maxX),
            y: min(max(origin.y, minY), maxY)
        )
    }

    /// 夹住拖动结果：至少留 80pt 在屏内，拖丢了还能抓回来。
    private func clamped(_ origin: NSPoint, forSize customSize: NSSize? = nil) -> NSPoint {
        let size = customSize ?? window.frame.size
        let center = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(center) })
            ?? NSScreen.main ?? NSScreen.screens.first else { return origin }
        let area = screen.visibleFrame
        let keep: CGFloat = 80
        let minX = area.minX - size.width + keep
        let maxX = area.maxX - keep
        let minY = area.minY - size.height + keep
        let maxY = area.maxY - keep
        return NSPoint(
            x: min(max(origin.x, minX), maxX),
            y: min(max(origin.y, minY), maxY)
        )
    }

    /// 卡片宽度，来自设置。
    private var cardWidth: CGFloat { CGFloat(max(320, min(720, payload.width ?? 452))) }

    private func fn(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size * scale, weight: weight)
    }

    init(payload: Payload) {
        self.payload = payload
        super.init()
        for group in payload.groups ?? [] where group.multi != true {
            picks[group.id] = []
        }
    }

    private func activateSelf() {
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 仅当焦点确实在卡片的文本输入框内时返回 true（避免划选只读正文时的 field editor 误判为输入态）。
    private func isEditingTextInput() -> Bool {
        guard let textView = window?.firstResponder as? NSTextView else { return false }
        return textFields.values.contains { $0.textView === textView }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        installEditMenu()
        build()
        place()
        window.initialFirstResponder = nil
        activateSelf()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(nil)
        DispatchQueue.main.async { [weak self] in
            self?.activateSelf()
            self?.window?.makeKeyAndOrderFront(nil)
            self?.window?.makeFirstResponder(nil)
        }
        installDragMonitor()
        if payload.sound == true { NSSound.beep() }
        if let ms = payload.autoDismissMs, ms > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(ms) / 1000) { [weak self] in
                self?.emitTimeout()
            }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handleKeyDown(event)
        }
    }

    private func digitFromEvent(_ event: NSEvent) -> Int? {
        // 优先用物理 keyCode（主键盘 1-9 与小键盘 1-9），彻底不受中文输入法或键盘布局影响。
        switch event.keyCode {
        case 18, 83: return 1
        case 19, 84: return 2
        case 20, 85: return 3
        case 21, 86: return 4
        case 23, 87: return 5
        case 22, 88: return 6
        case 26, 89: return 7
        case 28, 91: return 8
        case 25, 92: return 9
        default: break
        }
        if let chars = event.charactersIgnoringModifiers, chars.count == 1, let d = Int(chars), (1...9).contains(d) {
            return d
        }
        return nil
    }

    private func handleKeyDown(_ event: NSEvent) -> NSEvent? {
        let editingText = isEditingTextInput()
        let mods = event.modifierFlags.intersection([.command, .control, .option])

        // Esc：输入态先退出输入框焦点；非输入态关闭卡片。
        if event.keyCode == 53 {
            if editingText {
                window?.makeFirstResponder(nil)
            } else {
                dismiss()
            }
            return nil
        }

        // Return：非输入态直接按 ⏎ 提交；输入态按 ⌘⏎ 提交（普通 ⏎ 换行）。
        if event.keyCode == 36 || event.keyCode == 76 {
            if mods.contains(.command) || (!editingText && mods.isEmpty) {
                submitTapped()
                return nil
            }
            return event
        }

        // 数字键 1–9：非输入态直接按 1–9，输入态加 ⌘ 前缀（⌘1–⌘9）选中/取消选项或聚焦输入框。
        if let digit = digitFromEvent(event), let target = hotkeyTargets[digit] {
            let allowDirect = !editingText && mods.isEmpty
            let allowCmd = editingText && mods == .command
            if allowDirect || allowCmd {
                switch target {
                case let .choice(group, choice):
                    if editingText { window?.makeFirstResponder(nil) }
                    toggle(group: group, choice: choice)
                case let .input(groupId):
                    textFields[groupId]?.focusEditor()
                }
                return nil
            }
        }

        // E：非输入态直接按 E，输入态加 ⌘ 前缀（⌘E）切换展开 / 收起（keyCode 14 = E）。
        if canExpand,
           (event.keyCode == 14 || event.charactersIgnoringModifiers?.lowercased() == "e") {
            let allowDirect = !editingText && mods.isEmpty
            let allowCmd = editingText && mods == .command
            if allowDirect || allowCmd {
                toggleExpand()
                return nil
            }
        }

        return event
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: 布局

    private var isLightTheme: Bool {
        if let mode = payload.theme?.mode?.lowercased() {
            if mode == "light" { return true }
            if mode == "dark" { return false }
        }
        if let bgHex = payload.theme?.background {
            return isLightColor(color(bgHex))
        }
        return systemIsLight()
    }

    private var bgColor: NSColor {
        let fallback = isLightTheme
            ? NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
            : NSColor(srgbRed: 0.110, green: 0.110, blue: 0.118, alpha: 1)
        return color(payload.theme?.background, fallback: fallback, alpha: 0.98)
    }
    private var surfaceColor: NSColor {
        let fallback = isLightTheme
            ? NSColor(srgbRed: 0.945, green: 0.953, blue: 0.961, alpha: 1)
            : NSColor(srgbRed: 0.173, green: 0.173, blue: 0.180, alpha: 1)
        return color(payload.theme?.surface, fallback: fallback)
    }
    private var borderColor: NSColor {
        let fallback = isLightTheme
            ? NSColor(srgbRed: 0.855, green: 0.863, blue: 0.878, alpha: 1)
            : NSColor(srgbRed: 0.227, green: 0.227, blue: 0.235, alpha: 1)
        return color(payload.theme?.border, fallback: fallback)
    }
    private var primaryTextColor: NSColor {
        let fallback = isLightTheme
            ? NSColor(srgbRed: 0.122, green: 0.122, blue: 0.122, alpha: 1)
            : NSColor(srgbRed: 0.976, green: 0.980, blue: 0.984, alpha: 1)
        return color(payload.theme?.textPrimary, fallback: fallback)
    }
    private var secondaryTextColor: NSColor {
        let fallback = isLightTheme
            ? NSColor(srgbRed: 0.373, green: 0.388, blue: 0.408, alpha: 1)
            : NSColor(srgbRed: 0.678, green: 0.698, blue: 0.722, alpha: 1)
        return color(payload.theme?.textSecondary, fallback: fallback)
    }

    private func md(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, textColor: NSColor) -> NSAttributedString {
        renderMarkdown(
            text,
            fontSize: size * scale,
            baseWeight: weight,
            textColor: textColor,
            secondaryColor: secondaryTextColor,
            codeBg: surfaceColor,
            accentColor: color(payload.accent),
            lineSpacing: 4 * scale
        )
    }

    private func build(rebuilding: Bool = false) {
        let visible = (window?.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width: CGFloat = expanded
            ? min(max(cardWidth + 200, 660), visible.width - 80)
            : cardWidth
        let pad: CGFloat = 20
        let content = width - pad * 2
        let accent = color(payload.accent)
        let groups = payload.groups ?? []

        // 重建布局前暂存已输入的草稿与当前聚焦的输入框，避免展开/收起丢字或丢焦点。
        var focusedGroupId: String?
        if rebuilding {
            for (gid, input) in textFields {
                draftTexts[gid] = input.stringValue
                if window?.firstResponder === input.textView {
                    focusedGroupId = gid
                }
            }
            pills.removeAll()
            textFields.removeAll()
        }
        hotkeyTargets.removeAll()
        var nextHotkey = 1
        func allocateHotkey(_ target: HotkeyTarget) -> Int? {
            guard nextHotkey <= 9 else { return nil }
            let assigned = nextHotkey
            hotkeyTargets[assigned] = target
            nextHotkey += 1
            return assigned
        }

        let kickerWidth = max(120, content - 84)
        let titleAttr = md(payload.title, size: 15.5, weight: .semibold, textColor: primaryTextColor)
        let subtitleAttr = payload.subtitle.flatMap { $0.isEmpty ? nil : md($0, size: 12, textColor: secondaryTextColor) }
        let messageAttr = payload.message.flatMap { $0.isEmpty ? nil : md($0, size: 12.8, textColor: primaryTextColor.withAlphaComponent(0.88)) }
        let groupTextAttrs = groups.map { $0.text.isEmpty ? nil : md($0.text, size: 13.5, weight: .medium, textColor: primaryTextColor) }
        let groupDetailAttrs = groups.map { $0.detail.flatMap { d in d.isEmpty ? nil : md(d, size: 12, textColor: secondaryTextColor) } }

        var estimatedHeight = pad
        if let kicker = payload.kicker, !kicker.isEmpty {
            estimatedHeight += measure(kicker, font: fn(11, .semibold), width: kickerWidth) + 8
        }
        estimatedHeight += measureAttributed(titleAttr, width: content) + 8
        if let subtitleAttr {
            estimatedHeight += measureAttributed(subtitleAttr, width: content) + 6
        }
        if let messageAttr {
            estimatedHeight += measureAttributed(messageAttr, width: content) + 12
        }
        for (idx, group) in groups.enumerated() {
            if let attr = groupTextAttrs[idx] {
                estimatedHeight += measureAttributed(attr, width: content) + 8
            }
            if let attr = groupDetailAttrs[idx] {
                estimatedHeight += measureAttributed(attr, width: content) + 8
            }
            if group.input == true {
                estimatedHeight += ceil(68 * scale) + 14
            } else {
                estimatedHeight += CGFloat(group.choices.count) * ceil(36 * scale) + CGFloat(max(0, group.choices.count - 1)) * 6
                if payload.allowText == true { estimatedHeight += ceil(68 * scale) + 10 }
                estimatedHeight += 14
            }
        }
        let footerHeight: CGFloat = ceil(34 * scale) + pad + 12
        estimatedHeight += footerHeight + 12

        let compactMaxHeight = min(460, visible.height - 160)
        let expandedMaxHeight = visible.height - 96
        let maxHeight = expanded ? expandedMaxHeight : compactMaxHeight
        let shownHeight = min(estimatedHeight, maxHeight)
        let needsExpandButton = true
        canExpand = true

        if window == nil {
            window = CardWindow(
                contentRect: NSRect(x: 0, y: 0, width: width, height: shownHeight),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = true
            window.level = .floating
            window.appearance = NSAppearance(named: isLightTheme ? .aqua : .darkAqua)
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.isMovableByWindowBackground = true
            window.delegate = self
        } else {
            // 保持卡片尽量贴近原中心并 100% 限制在当前屏幕可见区内，防止展开后溢出。
            let old = window.frame
            let targetSize = NSSize(width: width, height: shownHeight)
            let newOrigin = fittedOnScreen(NSPoint(
                x: old.midX - width / 2,
                y: old.maxY - shownHeight
            ), forSize: targetSize)
            window.setFrame(NSRect(origin: newOrigin, size: targetSize), display: true, animate: true)
        }

        let card = CardView(frame: NSRect(x: 0, y: 0, width: width, height: shownHeight))
        card.wantsLayer = true
        card.layer?.backgroundColor = bgColor.cgColor
        card.layer?.cornerRadius = 14
        card.layer?.borderWidth = 1
        card.layer?.borderColor = borderColor.withAlphaComponent(0.65).cgColor
        card.layer?.masksToBounds = true

        // 内容滚动区（滚轮可完整浏览所有长内容）
        let scrollHeight = shownHeight - footerHeight
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: width, height: scrollHeight))
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true
        scroll.verticalScrollElasticity = .allowed
        let document = CardView(frame: NSRect(x: 0, y: 0, width: width, height: max(scrollHeight, estimatedHeight - footerHeight)))
        scroll.documentView = document
        card.addSubview(scroll)

        var y = pad
        let left = pad

        if let kicker = payload.kicker, !kicker.isEmpty {
            let field = label(kicker, font: fn(11, .semibold), color: accent, width: kickerWidth)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += field.frame.height + 8
        }

        let titleField = attributedLabel(titleAttr, width: needsExpandButton && (payload.kicker?.isEmpty ?? true) ? kickerWidth : content)
        titleField.frame.origin = NSPoint(x: left, y: y)
        document.addSubview(titleField)
        y += titleField.frame.height + 8

        if let subtitleAttr {
            let field = attributedLabel(subtitleAttr, width: content)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += field.frame.height + 6
        }

        if let messageAttr {
            let field = attributedLabel(messageAttr, width: content)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += field.frame.height + 12
        }

        for (idx, group) in groups.enumerated() {
            if let attr = groupTextAttrs[idx] {
                let text = attributedLabel(attr, width: content)
                text.frame.origin = NSPoint(x: left, y: y)
                document.addSubview(text)
                y += text.frame.height + 8
            }

            if let attr = groupDetailAttrs[idx] {
                let field = attributedLabel(attr, width: content)
                field.frame.origin = NSPoint(x: left, y: y)
                document.addSubview(field)
                y += field.frame.height + 8
            }

            if group.input == true {
                let placeholder = group.placeholder ?? "在这里输入你的回答（回车换行，⌘⏎ 提交）…"
                let hk = allocateHotkey(.input(group.id))
                let field = makeTextField(group: group.id, placeholder: placeholder, width: content, hotkey: hk)
                field.frame.origin = NSPoint(x: left, y: y)
                document.addSubview(field)
                y += ceil(68 * scale) + 14
                continue
            }

            var index = 0
            for choice in group.choices {
                let hk = allocateHotkey(.choice(group, choice))
                let pill = PillButton(
                    choice,
                    hotkey: hk,
                    width: content,
                    fontScale: scale,
                    accent: accent,
                    surface: surfaceColor,
                    border: borderColor,
                    textPrimary: primaryTextColor,
                    textSecondary: secondaryTextColor
                )
                pill.picked = (picks[group.id] ?? []).contains(choice.id)
                pill.frame.origin = NSPoint(x: left, y: y)
                pill.onTap = { [weak self] in self?.toggle(group: group, choice: choice) }
                document.addSubview(pill)
                pills[group.id, default: [:]][choice.id] = pill
                y += ceil(36 * scale)
                if index < group.choices.count - 1 { y += 6 }
                index += 1
            }
            if payload.allowText == true {
                y += 10
                let placeholder = group.placeholder ?? "也可以直接输入回答（回车换行，⌘⏎ 提交）…"
                let hk = allocateHotkey(.input(group.id))
                let field = makeTextField(
                    group: group.id,
                    placeholder: placeholder,
                    width: content,
                    hotkey: hk,
                    clearSinglePick: group.multi != true
                )
                field.frame.origin = NSPoint(x: left, y: y)
                document.addSubview(field)
                y += ceil(68 * scale)
            }
            y += 14
        }

        // 用真实排版最终高度修正滚动区，保证 100% 内容可用滚轮滑到底部、不裁切。
        let actualDocHeight = max(scrollHeight, y + 8)
        document.frame = NSRect(x: 0, y: 0, width: width, height: actualDocHeight)
        scroll.hasVerticalScroller = actualDocHeight > scrollHeight + 1
        // 首次打开且含选项/输入框时默认滚到最下方直接露出选项；点击「展开」时滚回顶部便于阅读全文。
        let scrollToBottom = !expanded && !groups.isEmpty && actualDocHeight > scrollHeight
        let initialScrollY: CGFloat = scrollToBottom ? max(0, actualDocHeight - scrollHeight) : 0
        scroll.contentView.scroll(to: NSPoint(x: 0, y: initialScrollY))
        scroll.reflectScrolledClipView(scroll.contentView)

        // 右上角「展开 E / 收起 E」按钮（固定悬浮在卡片右上角，不随内容滚走）。
        if needsExpandButton {
            let btnWidth: CGFloat = 68
            let toggleBtn = NSButton(frame: NSRect(x: width - pad - btnWidth, y: pad - 4, width: btnWidth, height: 22))
            toggleBtn.isBordered = false
            toggleBtn.wantsLayer = true
            toggleBtn.layer?.cornerRadius = 6
            toggleBtn.layer?.borderWidth = 1
            toggleBtn.layer?.borderColor = borderColor.cgColor
            toggleBtn.layer?.backgroundColor = surfaceColor.cgColor
            toggleBtn.focusRingType = .none
            toggleBtn.target = self
            toggleBtn.action = #selector(toggleExpand)
            let p = NSMutableParagraphStyle()
            p.alignment = .center
            toggleBtn.attributedTitle = NSAttributedString(
                string: expanded ? "收起 E" : "展开 E",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11 * min(scale, 1.2), weight: .medium),
                    .foregroundColor: secondaryTextColor,
                    .paragraphStyle: p,
                ]
            )
            card.addSubview(toggleBtn)
        }

        // 底部按钮区 + 顶部分割线
        let footer = CardView(frame: NSRect(x: 0, y: shownHeight - footerHeight, width: width, height: footerHeight))
        let divider = NSView(frame: NSRect(x: pad, y: 0, width: content, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = borderColor.withAlphaComponent(0.45).cgColor
        footer.addSubview(divider)
        card.addSubview(footer)

        let dismissTitle = payload.dismiss ?? "稍后处理"
        let submitTitle = payload.submit ?? "提交"
        let gap: CGFloat = 10
        let submitWidth = min(220, content * 0.56)
        let dismissWidth = content - submitWidth - gap
        let buttonY = floor((footerHeight - ceil(34 * scale)) / 2) + 2

        let submit = ActionButton(title: submitTitle, primary: true, accent: accent, width: submitWidth, fontScale: scale)
        submit.target = self
        submit.action = #selector(submitTapped)
        submit.frame.origin = NSPoint(x: width - pad - submitWidth, y: buttonY)
        footer.addSubview(submit)
        submitButton = submit

        let dismiss = ActionButton(
            title: dismissTitle,
            primary: false,
            accent: accent,
            width: dismissWidth,
            fontScale: scale,
            borderColor: borderColor,
            secondaryTextColor: primaryTextColor.withAlphaComponent(0.82)
        )
        dismiss.target = self
        dismiss.action = #selector(dismissTapped)
        dismiss.frame.origin = NSPoint(x: pad, y: buttonY)
        footer.addSubview(dismiss)

        window.contentView = card
        window.initialFirstResponder = nil
        if let gid = focusedGroupId, let input = textFields[gid] {
            input.focusEditor()
        } else {
            window.makeFirstResponder(nil)
        }
        refreshSubmit()
    }

    @objc private func toggleExpand() {
        expanded.toggle()
        build(rebuilding: true)
    }

    /// 按设置里的位置把窗口摆到屏幕可见区域。
    private func place() {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) })
            ?? NSScreen.main
            ?? NSScreen.screens.first else { return }
        let area = screen.visibleFrame
        let size = window.frame.size
        let margin: CGFloat = 24
        switch payload.position ?? "center" {
        case "top-right":
            window.setFrameOrigin(NSPoint(x: area.maxX - size.width - margin, y: area.maxY - size.height - margin))
        case "bottom-right":
            window.setFrameOrigin(NSPoint(x: area.maxX - size.width - margin, y: area.minY + margin))
        case "top-left":
            window.setFrameOrigin(NSPoint(x: area.minX + margin, y: area.maxY - size.height - margin))
        case "bottom-left":
            window.setFrameOrigin(NSPoint(x: area.minX + margin, y: area.minY + margin))
        case "top-center":
            window.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.maxY - size.height - margin))
        case "bottom-center":
            window.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.minY + margin))
        case "cursor":
            let gap: CGFloat = 16
            var x = mouse.x + gap
            var y = mouse.y - size.height - gap
            if x + size.width > area.maxX { x = mouse.x - size.width - gap }
            if y < area.minY { y = mouse.y + gap }
            if y + size.height > area.maxY { y = area.maxY - size.height - 8 }
            window.setFrameOrigin(NSPoint(
                x: max(area.minX + 8, min(x, area.maxX - size.width - 8)),
                y: max(area.minY + 8, y)
            ))
        default:
            window.center()
        }
        FileHandle.standardError.write(Data(
            "place: pos=\(payload.position ?? "center") mouse=(\(mouse.x),\(mouse.y)) origin=(\(window.frame.origin.x),\(window.frame.origin.y)) size=(\(size.width),\(size.height))\n".utf8))
    }

    // MARK: 交互

    private func toggle(group: Group, choice: Choice) {
        if isEditingTextInput() {
            window?.makeFirstResponder(nil)
        }
        var picked = picks[group.id] ?? []
        if group.multi == true {
            if picked.contains(choice.id) { picked.remove(choice.id) } else { picked.insert(choice.id) }
        } else {
            picked = picked.contains(choice.id) ? [] : [choice.id]
        }
        picks[group.id] = picked
        for (id, pill) in pills[group.id] ?? [:] {
            pill.picked = picked.contains(id)
        }
        refreshSubmit()
    }

    private func clearPicks(for groupId: String) {
        guard !(picks[groupId] ?? []).isEmpty else { return }
        picks[groupId] = []
        for (_, pill) in pills[groupId] ?? [:] {
            pill.picked = false
        }
        refreshSubmit()
    }

    /// 造一个支持自动换行与滚动的多行输入框，登记到 textFields，供提交时读取。
    private func makeTextField(group id: String, placeholder: String, width: CGFloat, hotkey: Int? = nil, clearSinglePick: Bool = false) -> MultiLineInputView {
        let input = MultiLineInputView(
            frame: NSRect(x: 0, y: 0, width: max(120, width), height: ceil(68 * scale)),
            placeholder: placeholder,
            hotkey: hotkey,
            font: fn(13),
            textColor: primaryTextColor,
            secondaryColor: secondaryTextColor,
            surfaceColor: surfaceColor,
            borderColor: borderColor,
            accentColor: color(payload.accent)
        )
        if let saved = draftTexts[id], !saved.isEmpty {
            input.textView.string = saved
            input.textDidChange(Notification(name: NSText.didChangeNotification))
        }
        if clearSinglePick {
            input.onFocus = { [weak self] in self?.clearPicks(for: id) }
        }
        input.onChange = { [weak self] in
            if clearSinglePick, !input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                self?.clearPicks(for: id)
            }
            self?.refreshSubmit()
        }
        textFields[id] = input
        return input
    }

    /// 这一组是否已经给出答案：optional 组永远可提交；纯输入组看文字；选项组看勾选（允许输入时也认文字）。
    private func answered(_ group: Group) -> Bool {
        if group.optional == true { return true }
        let text = (textFields[group.id]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if group.input == true { return !text.isEmpty }
        if !(picks[group.id] ?? []).isEmpty { return true }
        return payload.allowText == true && !text.isEmpty
    }

    private func canSubmit() -> Bool {
        let groups = payload.groups ?? []
        if groups.isEmpty || groups.allSatisfy({ $0.optional == true }) { return true }
        return groups.contains { $0.optional != true && answered($0) }
    }

    private func refreshSubmit() {
        guard let submitButton else { return }
        let ready = canSubmit()
        submitButton.isEnabled = ready
        submitButton.alphaValue = ready ? 1 : 0.45
        if let typedLabel = payload.submitWhenTyped, !typedLabel.isEmpty {
            let hasTyped = textFields.values.contains {
                !$0.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            submitButton.setLabel(hasTyped ? typedLabel : (payload.submit ?? "提交"))
        }
    }

    @objc private func submitTapped() {
        guard !settled else { return }
        let groups = payload.groups ?? []
        let typed: (Group) -> String = { group in
            (self.textFields[group.id]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if !canSubmit() { return }
        settled = true
        var answers: [String: [String]] = [:]
        var texts: [String: String] = [:]
        for group in groups {
            let text = typed(group)
            if group.input == true {
                answers[group.id] = text.isEmpty ? [] : [text]
                if !text.isEmpty { texts[group.id] = text }
            } else {
                answers[group.id] = Array(picks[group.id] ?? []).sorted()
                if payload.allowText == true, !text.isEmpty { texts[group.id] = text }
            }
        }
        emit(["result": "choose", "answers": answers, "texts": texts])
    }

    @objc private func dismissTapped() { dismiss() }

    private func dismiss() {
        guard !settled else { return }
        settled = true
        emit(["result": "dismiss"])
    }

    private func emitTimeout() {
        guard !settled else { return }
        settled = true
        emit(["result": "timeout"])
    }
}

extension CardController: NSTextFieldDelegate {
    func controlTextDidChange(_ notification: Notification) { refreshSubmit() }
}

extension CardController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) { dismiss() }
}

// MARK: - 入口

if CommandLine.arguments.contains("--screens") {
    var screens: [[String: Any]] = []
    for screen in NSScreen.screens {
        screens.append([
            "frame": NSStringFromRect(screen.frame),
            "visible": NSStringFromRect(screen.visibleFrame),
            "main": screen == NSScreen.main,
        ])
    }
    emit(["screens": screens, "mouse": NSStringFromPoint(NSEvent.mouseLocation)])
}

/// 取某个进程最大的一块普通窗口边界（CoreGraphics 坐标：左上原点、单位 pt）。
func windowBounds(of pid: pid_t) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    var best: CGRect?
    for info in list {
        guard let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let dict = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: dict as CFDictionary) else { continue }
        if rect.width < 400 || rect.height < 300 { continue }
        if best == nil || rect.width * rect.height > best!.width * best!.height { best = rect }
    }
    return best
}

/// 把鼠标指针挪到指定点（CoreGraphics 全局坐标）；结束后解除 warp 的短暂冻结。
func warpPointer(to point: CGPoint) {
    CGWarpMouseCursorPosition(point)
    CGAssociateMouseAndMouseCursorPosition(1)
}

/// 通过 macOS Accessibility API 按标题关键词（如会话标题、工作区目录名）精准拉起指定窗口，
/// 顺带取消最小化并返回该窗口在屏幕上的精确边界（供 --warp 挪指针使用）。
func raiseMatchingWindow(pid: pid_t, hints: [String]) -> CGRect? {
    guard !hints.isEmpty, AXIsProcessTrusted() else { return nil }
    let appEl = AXUIElementCreateApplication(pid)
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement], !windows.isEmpty else { return nil }

    let normalizedHints = hints.map { $0.lowercased() }.filter { !$0.isEmpty }
    var matched: AXUIElement?
    // 按提示优先级匹配（更具体的会话标题/目录名优先）。
    outer: for hint in normalizedHints {
        for win in windows {
            var titleObj: AnyObject?
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleObj) == .success,
               let title = titleObj as? String,
               title.lowercased().contains(hint) {
                matched = win
                break outer
            }
        }
    }
    guard let target = matched else { return nil }

    var minObj: AnyObject?
    if AXUIElementCopyAttributeValue(target, kAXMinimizedAttribute as CFString, &minObj) == .success,
       let isMin = minObj as? Bool, isMin {
        AXUIElementSetAttributeValue(target, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(target, kAXRaiseAction as CFString)

    var posObj: AnyObject?
    var sizeObj: AnyObject?
    if AXUIElementCopyAttributeValue(target, kAXPositionAttribute as CFString, &posObj) == .success,
       AXUIElementCopyAttributeValue(target, kAXSizeAttribute as CFString, &sizeObj) == .success,
       let posVal = posObj, let sizeVal = sizeObj {
        var pos = CGPoint.zero
        var size = CGSize.zero
        if AXValueGetValue(posVal as! AXValue, .cgPoint, &pos),
           AXValueGetValue(sizeVal as! AXValue, .cgSize, &size),
           size.width >= 200, size.height >= 200 {
            return CGRect(origin: pos, size: size)
        }
    }
    return nil
}

// 把宿主应用拉到前台（支持逗号分隔的多个 bundleId、--name 兜底与 --window-hint 多窗口精准切换）。
if CommandLine.arguments.contains("--activate") {
    let rawBundles = flagValue("--activate") ?? ""
    let bundles = rawBundles.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let rawNames = flagValue("--name") ?? ""
    let names = rawNames.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    let rawHints = flagValue("--window-hint") ?? ""
    let hints = rawHints.split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let shouldWarp = CommandLine.arguments.contains("--warp")

    var matchedApps: [NSRunningApplication] = []
    var matchedBundle = bundles.first ?? ""
    for bundle in bundles {
        let found = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
        if !found.isEmpty {
            matchedApps = found
            matchedBundle = bundle
            break
        }
    }
    if matchedApps.isEmpty, !names.isEmpty {
        matchedApps = NSWorkspace.shared.runningApplications.filter { app in
            guard let appName = app.localizedName?.lowercased() else { return false }
            return names.contains { appName.contains($0) }
        }
        if let first = matchedApps.first?.bundleIdentifier { matchedBundle = first }
    }

    var activated = false
    var targetBounds: CGRect?
    for app in matchedApps {
        if #available(macOS 14.0, *) {
            if app.activate() { activated = true }
        } else if app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
            activated = true
        }
        if !hints.isEmpty, let raised = raiseMatchingWindow(pid: app.processIdentifier, hints: hints) {
            targetBounds = raised
        }
    }
    var warped: CGPoint?
    if activated, shouldWarp, let app = matchedApps.first {
        Thread.sleep(forTimeInterval: 0.45)
        if targetBounds == nil, !hints.isEmpty {
            targetBounds = raiseMatchingWindow(pid: app.processIdentifier, hints: hints)
        }
        if let bounds = targetBounds ?? windowBounds(of: app.processIdentifier) {
            let point = CGPoint(x: bounds.midX, y: bounds.maxY - 90)
            warpPointer(to: point)
            warped = point
        }
    }
    emit([
        "activated": activated,
        "apps": matchedApps.count,
        "bundleId": matchedBundle,
        "matchedWindow": targetBounds != nil,
        "warped": warped.map { NSStringFromPoint($0) } ?? "none",
    ])
}

// 只读判断宿主 App 是否真的"看着"目标窗口：App 在前台 + 前台窗口标题命中 hint。
// 用于多窗口场景：同一 App 的另一个窗口在前台时，不应视为"宿主在前台"。
if CommandLine.arguments.contains("--check-window") {
    let rawBundles = flagValue("--check-window") ?? ""
    let bundles = rawBundles.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let rawHints = flagValue("--window-hint") ?? ""
    let hints = rawHints.split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }

    let front = NSWorkspace.shared.frontmostApplication
    let frontBundle = front?.bundleIdentifier ?? ""
    let hostFrontmost = bundles.contains { $0.caseInsensitiveCompare(frontBundle) == .orderedSame }

    var windowTitle = ""
    var matchedWindow = false
    if hostFrontmost, let pid = front?.processIdentifier, AXIsProcessTrusted() {
        let appEl = AXUIElementCreateApplication(pid)
        var winObj: AnyObject?
        if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &winObj) != .success {
            AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &winObj)
        }
        if let winObject = winObj, CFGetTypeID(winObject) == AXUIElementGetTypeID() {
            let win = winObject as! AXUIElement
            var titleObj: AnyObject?
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleObj) == .success,
               let title = titleObj as? String {
                windowTitle = title
                let lower = title.lowercased()
                matchedWindow = hints.isEmpty || hints.contains { lower.contains($0.lowercased()) }
            }
        }
    }
    emit([
        "hostFrontmost": hostFrontmost,
        "frontBundleId": frontBundle,
        "windowTitle": windowTitle,
        "matched": matchedWindow,
    ])
}

if CommandLine.arguments.contains("--probe") {
    let front = NSWorkspace.shared.frontmostApplication
    emit([
        "bundleId": front?.bundleIdentifier ?? "",
        "name": front?.localizedName ?? "",
        "appearance": systemIsLight() ? "light" : "dark",
    ])
}

let raw = FileHandle.standardInput.readDataToEndOfFile()
guard !raw.isEmpty, let payload = try? JSONDecoder().decode(Payload.self, from: raw) else {
    emit(["result": "error", "message": "invalid payload"])
}

let app = NSApplication.shared
let controller = CardController(payload: payload)
app.delegate = controller
app.setActivationPolicy(.accessory)
app.run()
