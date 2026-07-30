import Foundation

enum BoronClientError: LocalizedError {
    case missingToken
    case invalidResponse
    case serverStatus(Int)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            return "Boron daemon token is missing"
        case .invalidResponse:
            return "Boron returned an invalid response"
        case .serverStatus(let status):
            return "Boron returned HTTP \(status)"
        }
    }
}

struct BoronClient: Sendable {
    let baseURL: URL
    let tokenURL: URL
    let session: URLSession

    init(
        baseURL: URL = URL(string: "http://127.0.0.1:41635")!,
        tokenURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Boron Context/daemon.token"),
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenURL = tokenURL
        self.session = session
    }

    func health() async throws -> BoronHealth {
        let request = URLRequest(url: baseURL.appendingPathComponent("health"))
        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try JSONDecoder().decode(BoronHealth.self, from: data)
    }

    func meter(project: String = "Boron Context", windowDays: Int = 30) async throws
        -> ContextMeterSummary
    {
        let token = try String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw BoronClientError.missingToken
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("v1/metrics/context"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            MeterRequest(projectHint: project, windowDays: windowDays, typingWordsPerMinute: 40)
        )

        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try JSONDecoder().decode(ContextMeterSummary.self, from: data)
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw BoronClientError.invalidResponse
        }
        guard 200 ..< 300 ~= http.statusCode else {
            throw BoronClientError.serverStatus(http.statusCode)
        }
    }
}
