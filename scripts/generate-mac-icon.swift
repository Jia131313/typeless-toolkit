import AppKit
import Foundation

let fileManager = FileManager.default
let projectRoot = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
let sourceURL = projectRoot.appendingPathComponent("icon/icon.png")
let assetsURL = projectRoot.appendingPathComponent("assets", isDirectory: true)
let buildURL = projectRoot.appendingPathComponent(".build", isDirectory: true)
let iconsetURL = buildURL.appendingPathComponent("macos-icon.iconset", isDirectory: true)
let roundedURL = assetsURL.appendingPathComponent("icon-rounded.png")
let icnsURL = assetsURL.appendingPathComponent("icon.icns")

guard let source = NSImage(contentsOf: sourceURL) else {
    fputs("无法读取图标源: \(sourceURL.path)\n", stderr)
    exit(1)
}

func renderPNG(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "TypelessIcon", code: 1)
    }

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "TypelessIcon", code: 2)
    }
    NSGraphicsContext.current = context
    context.imageInterpolation = .high

    let bounds = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor.clear.setFill()
    bounds.fill()
    NSBezierPath(
        roundedRect: bounds,
        xRadius: CGFloat(size) * 0.22,
        yRadius: CGFloat(size) * 0.22
    ).addClip()
    source.draw(in: bounds, from: .zero, operation: .copy, fraction: 1.0)
    context.flushGraphics()

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "TypelessIcon", code: 3)
    }
    return data
}

try fileManager.createDirectory(at: assetsURL, withIntermediateDirectories: true)
try fileManager.createDirectory(at: buildURL, withIntermediateDirectories: true)
if fileManager.fileExists(atPath: iconsetURL.path) {
    try fileManager.removeItem(at: iconsetURL)
}
try fileManager.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

let iconFiles: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, size) in iconFiles {
    try renderPNG(size: size).write(to: iconsetURL.appendingPathComponent(name), options: .atomic)
}
try renderPNG(size: 1024).write(to: roundedURL, options: .atomic)

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", "-o", icnsURL.path, iconsetURL.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    fputs("iconutil 生成 ICNS 失败\n", stderr)
    exit(iconutil.terminationStatus)
}

print("已从 icon/icon.png 生成 assets/icon-rounded.png 与 assets/icon.icns")
