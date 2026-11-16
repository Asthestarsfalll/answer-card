// dsh-answer-card —— macOS 悬浮窗助手。
//
// 由宿主插件（Node 侧）以 stdin 传入一份 JSON 载荷启动，画一张置顶、无边框、
// 深色圆角的卡片，等你点完按钮后把结果用一行 JSON 写回 stdout 并退出。
//
// 载荷：
//   { kind, kicker, title, subtitle, message, groups:[{id,text,detail,multi,choices:[{id,label,hint}]}],
//     submit, dismiss, accent }
// 结果：
//   {"result":"choose","answers":{"<groupId>":["<choiceId>", ...]}}
//   {"result":"dismiss"}
//
// 另支持 `--probe`：只打印当前前台 app，不画窗口，供宿主判断 DSH 是否在前台。

import AppKit
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
    let choices: [Choice]
}

struct Payload: Decodable {
    let kind: String
    let kicker: String?
    let title: String
    let subtitle: String?
    let message: String?
    let groups: [Group]?
    let submit: String?
    let dismiss: String?
    let accent: String?
    let position: String?
    let width: Double?
    let fontScale: Double?
    let sound: Bool?
    let autoDismissMs: Int?
}

// MARK: - 小工具

func color(_ hex: String?) -> NSColor {
    guard let hex else { return NSColor(srgbRed: 0.30, green: 0.42, blue: 0.99, alpha: 1) }
    var value: UInt64 = 0
    var text = hex.replacingOccurrences(of: "#", with: "")
    if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
    guard Scanner(string: text).scanHexInt64(&value) else {
        return NSColor(srgbRed: 0.30, green: 0.42, blue: 0.99, alpha: 1)
    }
    return NSColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
        green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255,
        alpha: 1
    )
}

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
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
    return ceil(rect.height)
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

/// 圆角面板：用于窗口底板。
final class CardView: NSView {
    override var isFlipped: Bool { true }
}

/// 选项按钮：未选中是深灰描边，选中是品牌色描边 + 淡底。
final class PillButton: NSButton {
    var picked = false { didSet { refresh() } }
    var accent = color("#4D6BFE")
    var onTap: (() -> Void)?

    init(_ choice: Choice, width: CGFloat, fontScale: CGFloat, accent: NSColor) {
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: ceil(36 * fontScale)))
        self.accent = accent
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
        paragraph.lineBreakMode = .byTruncatingTail
        var title = choice.label
        if let hint = choice.hint, !hint.isEmpty {
            title += "   " + hint
        }
        let text = NSMutableAttributedString(
            string: title,
            attributes: [
                .foregroundColor: NSColor(srgbRed: 0.976, green: 0.980, blue: 0.984, alpha: 1),
                .font: NSFont.systemFont(ofSize: 13 * fontScale, weight: .medium),
                .paragraphStyle: paragraph,
            ]
        )
        if let hint = choice.hint, !hint.isEmpty, let range = title.range(of: hint) {
            let location = title.distance(from: title.startIndex, to: range.lowerBound)
            text.addAttribute(
                .foregroundColor,
                value: NSColor(srgbRed: 0.678, green: 0.698, blue: 0.722, alpha: 1),
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
        layer.backgroundColor = (picked
            ? accent.withAlphaComponent(0.22)
            : NSColor(srgbRed: 0.173, green: 0.173, blue: 0.180, alpha: 1)).cgColor
        layer.borderColor = (picked
            ? accent.withAlphaComponent(0.95)
            : NSColor(srgbRed: 0.227, green: 0.227, blue: 0.235, alpha: 1)).cgColor
    }
}

/// 主按钮（品牌色填充）/ 次按钮（描边）。
final class ActionButton: NSButton {
    init(title: String, primary: Bool, accent: NSColor, width: CGFloat, fontScale: CGFloat) {
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
            layer?.borderColor = NSColor(srgbRed: 0.29, green: 0.29, blue: 0.31, alpha: 1).cgColor
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: primary
                    ? NSColor.white
                    : NSColor(srgbRed: 0.78, green: 0.80, blue: 0.82, alpha: 1),
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
    private var picks: [String: Set<String>] = [:]
    private var pills: [String: [String: PillButton]] = [:]
    private var textFields: [String: NSTextField] = [:]
    private var submitButton: ActionButton?
    private var settled = false

    /// 整体字号缩放，来自设置页。
    private var scale: CGFloat { CGFloat(max(0.7, min(1.8, payload.fontScale ?? 1))) }
    /// 卡片宽度，来自设置页。
    private var cardWidth: CGFloat { CGFloat(max(320, min(720, payload.width ?? 452))) }

    private func fn(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size * scale, weight: weight)
    }

    init(payload: Payload) {
        self.payload = payload
        super.init()
        for group in payload.groups ?? [] where group.multi != true {
            // 单选组预置空集合，提交时取第一个（也是唯一一个）选中项。
            picks[group.id] = []
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        build()
        place()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if payload.sound == true { NSSound.beep() }
        if let ms = payload.autoDismissMs, ms > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(ms) / 1000) { [weak self] in
                self?.emitTimeout()
            }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.dismiss(); return nil }
            return event
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: 布局

    private func build() {
        let width = cardWidth
        let pad: CGFloat = 20
        let content = width - pad * 2
        let accent = color(payload.accent)
        let groups = payload.groups ?? []

        var height = pad
        if let kicker = payload.kicker, !kicker.isEmpty { height += 18 + 8 }
        height += measure(payload.title, font: .systemFont(ofSize: 16, weight: .semibold), width: content) + 8
        if let subtitle = payload.subtitle, !subtitle.isEmpty {
            height += measure(subtitle, font: .systemFont(ofSize: 12), width: content) + 6
        }
        if let message = payload.message, !message.isEmpty {
            height += measure(message, font: .systemFont(ofSize: 12.5), width: content) + 10
        }
        for group in groups {
            height += measure(group.text, font: .systemFont(ofSize: 13.5), width: content) + 8
            if let detail = group.detail, !detail.isEmpty {
                height += measure(detail, font: .systemFont(ofSize: 11.5), width: content) + 6
            }
            if group.input == true {
                height += 38 + 14
            } else {
                height += CGFloat(group.choices.count) * ceil(36 * scale) + CGFloat(max(0, group.choices.count - 1)) * 6 + 14
            }
        }
        height += 40 + pad

        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let maxHeight = visible.height - 120
        let shownHeight = min(height, maxHeight)

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
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true
        window.delegate = self

        let card = CardView(frame: NSRect(x: 0, y: 0, width: width, height: shownHeight))
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor(srgbRed: 0.110, green: 0.110, blue: 0.118, alpha: 0.98).cgColor
        card.layer?.cornerRadius = 14
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.10).cgColor
        card.layer?.masksToBounds = true

        // 内容滚动区（组很多时）
        let footerHeight: CGFloat = ceil(34 * scale) + pad
        let scrollHeight = shownHeight - footerHeight
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: width, height: scrollHeight))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = height > shownHeight
        scroll.autohidesScrollers = true
        scroll.verticalScrollElasticity = .automatic
        let document = CardView(frame: NSRect(x: 0, y: 0, width: width, height: max(scrollHeight, height)))
        scroll.documentView = document
        card.addSubview(scroll)

        var y = pad
        let left = pad

        if let kicker = payload.kicker, !kicker.isEmpty {
            let field = label(kicker, font: .systemFont(ofSize: 11, weight: .semibold),
                              color: accent, width: content)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += 18 + 8
        }

        let titleField = label(payload.title, font: .systemFont(ofSize: 16, weight: .semibold),
                               color: NSColor(srgbRed: 0.976, green: 0.980, blue: 0.984, alpha: 1), width: content)
        titleField.frame.origin = NSPoint(x: left, y: y)
        document.addSubview(titleField)
        y += titleField.frame.height + 8

        if let subtitle = payload.subtitle, !subtitle.isEmpty {
            let field = label(subtitle, font: .systemFont(ofSize: 12),
                              color: NSColor(srgbRed: 0.678, green: 0.698, blue: 0.722, alpha: 1), width: content)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += field.frame.height + 6
        }

        if let message = payload.message, !message.isEmpty {
            let field = label(message, font: .systemFont(ofSize: 12.5),
                              color: NSColor(srgbRed: 0.80, green: 0.82, blue: 0.84, alpha: 1), width: content)
            field.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(field)
            y += field.frame.height + 10
        }

        for group in groups {
            let text = label(group.text, font: .systemFont(ofSize: 13.5),
                             color: NSColor(srgbRed: 0.90, green: 0.92, blue: 0.94, alpha: 1), width: content)
            text.frame.origin = NSPoint(x: left, y: y)
            document.addSubview(text)
            y += text.frame.height + 8

            if let detail = group.detail, !detail.isEmpty {
                let field = label(detail, font: .systemFont(ofSize: 11.5),
                                  color: NSColor(srgbRed: 0.62, green: 0.64, blue: 0.68, alpha: 1), width: content)
                field.frame.origin = NSPoint(x: left, y: y)
                document.addSubview(field)
                y += field.frame.height + 6
            }

            if group.input == true {
                let field = NSTextField(frame: NSRect(x: left, y: y, width: content, height: ceil(34 * scale)))
                field.placeholderString = "在这里输入你的回答…"
                field.font = fn(13)
                field.textColor = NSColor(srgbRed: 0.976, green: 0.980, blue: 0.984, alpha: 1)
                field.backgroundColor = NSColor(srgbRed: 0.173, green: 0.173, blue: 0.180, alpha: 1)
                field.isBezeled = false
                field.focusRingType = .none
                field.wantsLayer = true
                field.layer?.cornerRadius = 9
                field.layer?.borderWidth = 1
                field.layer?.borderColor = NSColor(srgbRed: 0.227, green: 0.227, blue: 0.235, alpha: 1).cgColor
                field.delegate = self
                document.addSubview(field)
                textFields[group.id] = field
                y += ceil(34 * scale) + 4 + 14
                continue
            }

            var index = 0
            for choice in group.choices {
                let pill = PillButton(choice, width: content, fontScale: scale, accent: accent)
                pill.frame.origin = NSPoint(x: left, y: y)
                pill.onTap = { [weak self] in self?.toggle(group: group, choice: choice) }
                document.addSubview(pill)
                pills[group.id, default: [:]][choice.id] = pill
                y += ceil(36 * scale)
                if index < group.choices.count - 1 { y += 6 }
                index += 1
            }
            y += 14
        }

        // 底部按钮
        let footer = NSView(frame: NSRect(x: 0, y: shownHeight - footerHeight, width: width, height: footerHeight))
        card.addSubview(footer)

        let dismissTitle = payload.dismiss ?? "稍后处理"
        let submitTitle = payload.submit ?? "提交"
        let gap: CGFloat = 10
        let submitWidth = min(200, content * 0.56)
        let dismissWidth = content - submitWidth - gap

        let submit = ActionButton(title: submitTitle, primary: true, accent: accent, width: submitWidth, fontScale: scale)
        submit.target = self
        submit.action = #selector(submitTapped)
        submit.frame.origin = NSPoint(x: width - pad - submitWidth, y: pad - 2)
        footer.addSubview(submit)
        submitButton = submit

        let dismiss = ActionButton(title: dismissTitle, primary: false, accent: accent, width: dismissWidth, fontScale: scale)
        dismiss.target = self
        dismiss.action = #selector(dismissTapped)
        dismiss.frame.origin = NSPoint(x: pad, y: pad - 2)
        footer.addSubview(dismiss)

        window.contentView = card
        refreshSubmit()
    }

    /// 按设置里的位置把窗口摆到屏幕可见区域。
    private func place() {
        // 「光标附近」跟着鼠标走：先找鼠标所在的那块屏幕，拿不到再退回主屏。
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
            // 贴在光标右下方；右边或下边放不下就翻到另一侧，最后夹进可见区域。
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
        // 诊断：stderr 写一行摆位结果，宿主不解析，只在排查位置问题时看。
        FileHandle.standardError.write(Data(
            "place: pos=\(payload.position ?? "center") mouse=(\(mouse.x),\(mouse.y)) origin=(\(window.frame.origin.x),\(window.frame.origin.y)) size=(\(size.width),\(size.height))\n".utf8))
    }

    // MARK: 交互

    private func toggle(group: Group, choice: Choice) {
        var picked = picks[group.id] ?? []
        if group.multi == true {
            if picked.contains(choice.id) { picked.remove(choice.id) } else { picked.insert(choice.id) }
        } else {
            picked = [choice.id]
        }
        picks[group.id] = picked
        for (id, pill) in pills[group.id] ?? [:] {
            pill.picked = picked.contains(id)
        }
        refreshSubmit()
    }

    private func refreshSubmit() {
        guard let submitButton else { return }
        let groups = payload.groups ?? []
        let ready = groups.allSatisfy { group in
            if group.input == true {
                let text = (textFields[group.id]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return !text.isEmpty
            }
            return !(picks[group.id] ?? []).isEmpty
        }
        submitButton.isEnabled = ready
        submitButton.alphaValue = ready ? 1 : 0.45
    }

    @objc private func submitTapped() {
        let groups = payload.groups ?? []
        let typed: (Group) -> String = { group in
            (self.textFields[group.id]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let ready = groups.allSatisfy { group in
            group.input == true ? !typed(group).isEmpty : !(picks[group.id] ?? []).isEmpty
        }
        if !ready { return }
        var answers: [String: [String]] = [:]
        for group in groups {
            answers[group.id] = group.input == true ? [typed(group)] : Array(picks[group.id] ?? []).sorted()
        }
        emit(["result": "choose", "answers": answers])
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

// 把 DSH 拉到前台：不带窗口地激活进程，macOS 会切到该应用窗口所在的 Space。
// 已最小化的窗口由 Electron 自己的 activate 处理器 restore，这里只负责「切 Space + 抢焦点」。
// 带 `--warp` 时再把鼠标指针挪到窗口底部的输入框附近 —— 跨屏 / 跨 Space 之后指针
// 常常还留在原处，键盘焦点回来了、手却要自己找鼠标。
if CommandLine.arguments.contains("--activate") {
    let bundle = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "io.dsh.desktop"
    let shouldWarp = CommandLine.arguments.contains("--warp")
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    var activated = false
    for app in apps {
        if #available(macOS 14.0, *) {
            // 14 起 ignoringOtherApps 无效；activate() 本身就会把应用带到当前 Space。
            if app.activate() { activated = true }
        } else if app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
            activated = true
        }
    }
    var warped: CGPoint?
    if activated, shouldWarp, let app = apps.first {
        // 给 Space 切换动画一点时间，否则拿到的还是切换前的窗口位置。
        Thread.sleep(forTimeInterval: 0.55)
        if let bounds = windowBounds(of: app.processIdentifier) {
            // 输入框在窗口底部，抬高约 90pt 落在输入区内。
            let point = CGPoint(x: bounds.midX, y: bounds.maxY - 90)
            warpPointer(to: point)
            warped = point
        }
    }
    emit([
        "activated": activated,
        "apps": apps.count,
        "bundleId": bundle,
        "warped": warped.map { NSStringFromPoint($0) } ?? "none",
    ])
}

if CommandLine.arguments.contains("--probe") {
    let front = NSWorkspace.shared.frontmostApplication
    emit([
        "bundleId": front?.bundleIdentifier ?? "",
        "name": front?.localizedName ?? "",
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
