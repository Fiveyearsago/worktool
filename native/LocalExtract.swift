import Foundation
import Vision
import AppKit

func recognize(_ cg: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.012 { return $0.boundingBox.midY > $1.boundingBox.midY }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }
    var rows: [[VNRecognizedTextObservation]] = []
    for item in observations {
        if let last = rows.last, let first = last.first,
           abs(first.boundingBox.midY - item.boundingBox.midY) < min(first.boundingBox.height, item.boundingBox.height) * 0.5 {
            rows[rows.count-1].append(item)
        } else { rows.append([item]) }
    }
    return rows.map { row in
        row.sorted { $0.boundingBox.minX < $1.boundingBox.minX }.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\t")
    }.joined(separator: "\n")
}

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "需要文件路径", code: 1) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    var texts: [String] = []
        guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw NSError(domain: "图片无法读取", code: 4) }
        guard cg.width <= 16000, cg.height <= 16000, cg.width * cg.height <= 60000000 else { throw NSError(domain: "图片尺寸过大，请裁剪后导入", code: 5) }
        texts.append(try recognize(cg))
    print(texts.joined(separator: "\n\n"))
} catch {
    FileHandle.standardError.write(Data("本地识别失败：\(error.localizedDescription)\n".utf8))
    exit(1)
}
