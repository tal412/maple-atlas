import AppKit
import SwiftUI

/// Live window thumbnail with the minimap region drawn on top. Dragging draws a new region.
/// `region` is normalized to the window (0–1, top-left origin).
struct MinimapRegionEditor: View {
    let image: CGImage?
    let region: CGRect
    let onChange: (CGRect) -> Void

    @State private var draft: CGRect?

    private var aspectRatio: CGFloat {
        guard let image, image.height > 0 else { return 16 / 10 }
        return CGFloat(image.width) / CGFloat(image.height)
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let shown = draft ?? region
            let box = CGRect(
                x: shown.minX * size.width, y: shown.minY * size.height,
                width: shown.width * size.width, height: shown.height * size.height)

            ZStack(alignment: .topLeading) {
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.medium)
                } else {
                    Rectangle().fill(.quaternary)
                    Text("Waiting for a preview…")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                // Dim everything outside the region.
                Path { path in
                    path.addRect(CGRect(origin: .zero, size: size))
                    path.addRect(box)
                }
                .fill(Color.black.opacity(0.45), style: FillStyle(eoFill: true))
                Path { $0.addRect(box) }
                    .stroke(Color.accentColor, lineWidth: 2)
                Text("Minimap")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 3))
                    .foregroundStyle(.white)
                    .offset(x: box.minX + 3, y: box.minY + 3)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 3)
                    .onChanged { value in
                        draft = normalized(from: value.startLocation, to: value.location, in: size)
                    }
                    .onEnded { value in
                        draft = nil
                        onChange(normalized(from: value.startLocation, to: value.location, in: size))
                    }
            )
            .onHover { inside in
                if inside { NSCursor.crosshair.push() } else { NSCursor.pop() }
            }
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .frame(maxWidth: .infinity, maxHeight: 260)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel("Game window preview with the minimap area marked")
    }

    private func normalized(from start: CGPoint, to end: CGPoint, in size: CGSize) -> CGRect {
        guard size.width > 0, size.height > 0 else { return region }
        let clamp = { (value: CGFloat) in min(max(value, 0), 1) }
        let x0 = clamp(start.x / size.width), x1 = clamp(end.x / size.width)
        let y0 = clamp(start.y / size.height), y1 = clamp(end.y / size.height)
        return CGRect(x: min(x0, x1), y: min(y0, y1), width: abs(x1 - x0), height: abs(y1 - y0))
    }
}
