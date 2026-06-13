import AppKit
import CoreImage
import Foundation

guard CommandLine.arguments.count >= 3 else {
  fputs("Usage: swift scripts/generate_qr_code.swift <text> <output-path> [size]\n", stderr)
  exit(1)
}

let text = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let size = CommandLine.arguments.count >= 4 ? Int(CommandLine.arguments[3]) ?? 720 : 720

guard let data = text.data(using: .utf8) else {
  fputs("Failed to encode QR payload.\n", stderr)
  exit(1)
}

guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
  fputs("CIQRCodeGenerator is unavailable.\n", stderr)
  exit(1)
}

filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")

guard let outputImage = filter.outputImage else {
  fputs("Failed to generate QR image.\n", stderr)
  exit(1)
}

guard let falseColorFilter = CIFilter(name: "CIFalseColor") else {
  fputs("CIFalseColor is unavailable.\n", stderr)
  exit(1)
}

falseColorFilter.setValue(outputImage, forKey: kCIInputImageKey)
falseColorFilter.setValue(CIColor(red: 1, green: 1, blue: 1, alpha: 1), forKey: "inputColor0")
falseColorFilter.setValue(CIColor(red: 1, green: 1, blue: 1, alpha: 0), forKey: "inputColor1")

guard let styledImage = falseColorFilter.outputImage else {
  fputs("Failed to recolor QR image.\n", stderr)
  exit(1)
}

let extent = styledImage.extent.integral
let representation = NSCIImageRep(ciImage: styledImage)
let qrImage = NSImage(size: representation.size)
qrImage.addRepresentation(representation)

let scaledSize = NSSize(width: size, height: size)
guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(scaledSize.width),
  pixelsHigh: Int(scaledSize.height),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("Failed to create bitmap for QR image.\n", stderr)
  exit(1)
}

guard let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Failed to access graphics context for QR image.\n", stderr)
  exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphicsContext
graphicsContext.imageInterpolation = .none
NSColor.clear.setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: scaledSize)).fill()
qrImage.draw(
  in: NSRect(origin: .zero, size: scaledSize),
  from: NSRect(origin: .zero, size: extent.size),
  operation: .sourceOver,
  fraction: 1.0
)
graphicsContext.flushGraphics()
NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Failed to encode QR code PNG.\n", stderr)
  exit(1)
}

do {
  try pngData.write(to: URL(fileURLWithPath: outputPath))
} catch {
  fputs("Failed to write QR code image.\n", stderr)
  exit(1)
}
