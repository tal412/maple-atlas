import CoreImage
import CoreImage.CIFilterBuiltins

enum QRCode {
    /// Renders `string` as a QR code (error correction M) at whole-pixel module size,
    /// so it can be scaled up with nearest-neighbour interpolation and stay crisp.
    static func image(for string: String, moduleSize: CGFloat = 8) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: moduleSize, y: moduleSize))
        return CIContext(options: [.useSoftwareRenderer: false]).createCGImage(scaled, from: scaled.extent)
    }
}
