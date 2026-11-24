import AppKit
import ApplicationServices

// Connect one existing Windows App bookmark. Never reads password fields or
// accepts certificate dialogs. Windows App retains ownership of credentials.
func result(_ status: String) -> Never { print(status); exit(0) }
let args = CommandLine.arguments
if args.count != 2 || args[1].isEmpty || args[1].count > 512 { result("INVALID_TARGET") }
let name = args[1]
guard AXIsProcessTrusted() else { result("ACCESSIBILITY_REQUIRED") }
let bundleID = "com.microsoft.rdc.macos"
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { result("CLIENT_NOT_RUNNING") }
app.activate(options: [.activateAllWindows])
let root = AXUIElementCreateApplication(app.processIdentifier)
func attr(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success ? value : nil
}
func text(_ node: AXUIElement, _ key: String) -> String { attr(node, key) as? String ?? "" }
func descendants(_ node: AXUIElement) -> [AXUIElement] {
    var queue = [(node, 0)], found = [AXUIElement](), index = 0
    while index < queue.count && index < 3000 {
        let (item, depth) = queue[index]; index += 1; found.append(item)
        if depth >= 12 || text(item, kAXRoleAttribute) == kAXTextFieldRole { continue }
        let children = attr(item, kAXChildrenAttribute) as? [AXUIElement] ?? []
        queue.append(contentsOf: children.map { ($0, depth + 1) })
    }
    return found
}
func bounds(_ node: AXUIElement) -> CGRect? {
    guard let p = attr(node,kAXPositionAttribute), let s = attr(node,kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue,.cgPoint,&position),
          AXValueGetValue(s as! AXValue,.cgSize,&size), size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin:position,size:size)
}
func visibleWindows() -> [AXUIElement] {
    // Windows App keeps dismissed dialogs in its AX tree. Only inspect windows
    // that the window server reports on screen; no screen capture is involved.
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
    let visibleBounds = info.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier }
        .compactMap { ($0[kCGWindowBounds as String] as? [String:Any]).flatMap { CGRect(dictionaryRepresentation:$0 as CFDictionary) } }
    let windows = attr(root,kAXWindowsAttribute) as? [AXUIElement] ?? []
    return windows.filter { window in
        guard let rect = bounds(window), attr(window,kAXMinimizedAttribute) as? Bool != true else { return false }
        return visibleBounds.contains { abs($0.minX-rect.minX) < 2 && abs($0.minY-rect.minY) < 2 && abs($0.width-rect.width) < 2 && abs($0.height-rect.height) < 2 }
    }
}
func hasDialog(_ nodes: [AXUIElement]) -> Bool {
    nodes.contains { text($0,kAXRoleAttribute) == kAXSheetRole || text($0,kAXSubroleAttribute) == kAXDialogSubrole || (attr($0,kAXModalAttribute) as? Bool == true) }
}
let deadline = Date().addingTimeInterval(5)
repeat {
    let nodes = visibleWindows().flatMap { descendants($0) }
    // Never type over or dismiss an authentication/certificate sheet.
    if hasDialog(nodes) { result("CLIENT_DIALOG_OPEN") }
    let candidates = nodes.filter { node in
        let role = text(node, kAXRoleAttribute)
        return [kAXGroupRole, kAXRowRole, kAXCellRole].contains(role) &&
          [text(node,kAXTitleAttribute),text(node,kAXDescriptionAttribute)].contains(name)
    }
    if candidates.count > 1 { result("AMBIGUOUS_TARGET") }
    if let target = candidates.first {
        guard let rect = bounds(target), app.isActive else { result("TARGET_NOT_VISIBLE") }
        let point = CGPoint(x:rect.midX,y:rect.midY)
        for count in 1...2 {
            let down = CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)
            let up = CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)
            down?.setIntegerValueField(.mouseEventClickState,value:Int64(count)); up?.setIntegerValueField(.mouseEventClickState,value:Int64(count))
            down?.post(tap:.cghidEventTap); up?.post(tap:.cghidEventTap)
            Thread.sleep(forTimeInterval:0.08)
        }
        result("OPENED")
    }
    RunLoop.current.run(until:Date().addingTimeInterval(0.1))
} while Date() < deadline
result("TARGET_NOT_VISIBLE")
