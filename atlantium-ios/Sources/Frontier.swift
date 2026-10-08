import SwiftUI

enum PublicSection: String, CaseIterable { case feed = "Feed", jobs = "Jobs", directory = "Directory" }
extension PublicSection: Identifiable { var id: String { rawValue } }
struct FrontierView: View {
    var body: some View { PublicList(kind: .feed).navigationTitle("Frontier").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .topBarTrailing) { AccountButton() } } }
}
struct PublicList: View {
    let kind: PublicSection
    @State var items: [APIValue] = []
    @State var query = ""
    @State var category = ""
    @State var jobField = ""
    @State var seniority = ""
    @State var noDegree = false
    @State var newWeek = false
    @State var salaryFloor = 0
    @State var counts: APIValue = .null
    @State var fields: APIValue = .null
    @State private var generation = 0
    @State var error = ""
    @State var loading = true
    @State var total = 0
    @State var loadingMore = false
    @State var searchTask: Task<Void, Never>?
    var categories: [String] { kind == .directory ? ["All", "company", "investor", "grant", "resource"] : ["All", "remote", "hybrid", "onsite"] }
    var body: some View { Group {
        if loading && items.isEmpty { ProgressView("Loading \(kind.rawValue.lowercased())…").frame(maxWidth: .infinity, maxHeight: .infinity) }
        else if !error.isEmpty && items.isEmpty { LoadError(message: error) { Task { await load() } } }
        else if kind == .feed {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(items, id: \.id) { item in
                        NavigationLink { PublicDetail(kind: .feed, item: item) } label: {
                            FrontierArticleCard(item: item)
                        }.buttonStyle(.plain)
                    }
                    if items.isEmpty { ContentUnavailableView("No articles yet", systemImage: "newspaper", description: Text("New stories will appear here.")) }
                    if items.count < total { Button { Task { await load(more: true) } } label: { HStack { Text("Load more"); if loadingMore { ProgressView() } } }.disabled(loadingMore) }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.refreshable { await load() }
        }
        else { catalog }
    }.task(id: kind.rawValue) { await load() }
        .onChange(of: query) { _, _ in searchTask?.cancel(); searchTask = Task { try? await Task.sleep(for: .milliseconds(350)); if !Task.isCancelled { await load() } } }
        .onChange(of: jobField) { _, _ in scheduleLoad() }
        .onChange(of: seniority) { _, _ in scheduleLoad() }
        .onChange(of: category) { _, _ in scheduleLoad() }
        .onChange(of: noDegree) { _, _ in scheduleLoad() }
        .onChange(of: newWeek) { _, _ in scheduleLoad() }
        .onChange(of: salaryFloor) { _, _ in scheduleLoad() }
        .toolbar { if kind != .feed { ToolbarItem(placement: .principal) { filters } } }
    }
    var catalog: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    CatalogMetric(value: total.formatted(), label: kind == .jobs ? "Open roles" : "Results", icon: kind == .jobs ? "briefcase" : "building.2")
                    CatalogMetric(value: metric(kind == .jobs ? "remote" : "company"), label: kind == .jobs ? "Remote" : "Companies", icon: kind == .jobs ? "globe" : "building.2")
                    CatalogMetric(value: metric(kind == .jobs ? "new_this_week" : "investor"), label: kind == .jobs ? "New this week" : "Investors", icon: kind == .jobs ? "sparkles" : "chart.line.uptrend.xyaxis")
                }.padding(.bottom, 4)
                HStack(spacing: 9) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(kind == .jobs ? "Role, company, or skill" : "Search the directory", text: $query).font(.subheadline).submitLabel(.search)
                    if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.accessibilityLabel("Clear search") }
                }.padding(12).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                HStack { Text(kind == .jobs ? "Your next move" : "Explore the ecosystem").font(.headline); Spacer(); if loading { ProgressView().controlSize(.small) } }.padding(.top, 8).padding(.bottom, 3)
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                ForEach(items, id: \.id) { item in
                    NavigationLink { PublicDetail(kind: kind, item: item) } label: { CatalogItemCard(kind: kind, item: item) }.buttonStyle(.plain)
                }
                if items.isEmpty { ContentUnavailableView.search(text: query) }
                if items.count < total { Button { Task { await load(more: true) } } label: { HStack { Text("Load more"); if loadingMore { ProgressView() } }.font(.subheadline).frame(maxWidth: .infinity).padding(12) }.disabled(loadingMore) }
            }.padding(.horizontal, 14).padding(.vertical, 12)
        }.refreshable { await load() }.background(AppNightBackground())
    }
    func scheduleLoad() { searchTask?.cancel(); searchTask = Task { try? await Task.sleep(for: .milliseconds(150)); if !Task.isCancelled { await load() } } }
    func metric(_ key: String) -> String { if case .number(let n) = counts[key] { return Int(n).formatted() }; return "—" }
    var filters: some View {
        Menu {
            if kind == .jobs {
                Section("Tech field") {
                    Picker("Field", selection: $jobField) {
                        ForEach(["", "software", "data_ai", "cloud_devops", "security", "product_design", "sales_marketing"], id: \.self) { field in Text(fieldMenuLabel(field)).tag(field) }
                    }
                }
                Section("Workplace") { Picker("Workplace", selection: $category) { Text("Anywhere").tag(""); Text("Remote").tag("remote"); Text("Hybrid").tag("hybrid"); Text("Onsite").tag("onsite") } }
                Section("Experience") { Picker("Seniority", selection: $seniority) { Text("Any level").tag(""); ForEach(["Entry Level", "Mid Level", "Senior Level", "Lead", "Manager"], id: \.self) { Text($0).tag($0) } } }
                Section("Narrow it down") {
                    Toggle("New this week", isOn: $newWeek)
                    Toggle("No degree required or equivalent", isOn: $noDegree)
                    Picker("Salary reaches", selection: $salaryFloor) { Text("Any salary").tag(0); Text("$100k+").tag(100000); Text("$150k+").tag(150000); Text("$200k+").tag(200000) }
                }
            } else {
                Section("Browse") { Picker("Directory type", selection: $category) { Text("Everything").tag(""); ForEach(["company", "investor", "grant", "resource", "person"], id: \.self) { type in Text(type.capitalized + " · " + metric(type)).tag(type) } } }
            }
            Button("Reset filters") { category = ""; jobField = ""; seniority = ""; noDegree = false; newWeek = false; salaryFloor = 0 }
        } label: {
            HStack(spacing: 6) { Text(kind == .jobs ? fieldLabel(jobField) : category.isEmpty ? "Directory" : category.capitalized).font(.subheadline.weight(.semibold)).lineLimit(1); Image(systemName: "slider.horizontal.3").font(.caption); Image(systemName: "chevron.down").font(.caption2) }
        }.buttonStyle(.plain).modifier(CatalogMenuSurface())
    }
    func fieldMenuLabel(_ value: String) -> String { if value.isEmpty { return "All tech roles" }; if case .number(let n) = fields[value] { return fieldLabel(value) + " · " + Int(n).formatted() }; return fieldLabel(value) }
    func fieldLabel(_ value: String) -> String { ["": "Jobs", "software": "Software", "data_ai": "Data & AI", "cloud_devops": "Cloud & DevOps", "security": "Security", "product_design": "Product & design", "sales_marketing": "Sales & marketing"][value] ?? value }
    func load(more: Bool = false) async {
        if more && (loadingMore || loading) { return }
        generation += 1; let requestGeneration = generation
        if more { loadingMore = true } else { loading = true }
        defer { if requestGeneration == generation { loading = false; loadingMore = false } }
        var components = URLComponents(); var params = [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "offset", value: String(more ? items.count : 0))]
        if !query.isEmpty { params.append(URLQueryItem(name: "q", value: query)) }
        if kind == .jobs { params.append(URLQueryItem(name: "format", value: "paged")); params.append(URLQueryItem(name: "field", value: jobField)) }
        if kind == .jobs { if !seniority.isEmpty { params.append(URLQueryItem(name: "seniority", value: seniority)) }; if noDegree { params.append(URLQueryItem(name: "no_degree", value: "1")) }; if newWeek { params.append(URLQueryItem(name: "new_this_week", value: "1")) }; if salaryFloor > 0 { params.append(URLQueryItem(name: "salary_floor", value: String(salaryFloor))) } }
        if kind == .feed { params.append(URLQueryItem(name: "type", value: "post")) }
        if !category.isEmpty { params.append(URLQueryItem(name: kind == .directory ? "kind" : "workplace_type", value: kind == .jobs ? (category == "onsite" ? "Onsite" : category.capitalized) : category)) }
        components.queryItems = params
        let route = kind == .feed ? "content/documents" : kind == .jobs ? "job_postings" : "directory"
        do { let result = try await API.shared.call(route + "?" + (components.percentEncodedQuery ?? "")); let rows = kind == .feed ? result["documents"].list : kind == .directory ? result["entries"].list : result["jobs"].list
            guard requestGeneration == generation else { return }; counts = result["counts"]; fields = result["fields"]
            if more { let ids = Set(items.map(\.id)); items += rows.filter { !ids.contains($0.id) } } else { items = rows }
            if case .number(let count) = result["total"] { total = Int(count) } else { total = items.count }
            error = ""
        } catch { if !Task.isCancelled && requestGeneration == generation { self.error = error.localizedDescription } }
    }
}
struct FrontierArticleCard: View {
    let item: APIValue
    @ScaledMetric(relativeTo: .headline) private var cardHeight = 240.0
    var publishedDate: Date? {
        let value = item["published_at"].text
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    var body: some View {
        Color.black
            .frame(height: cardHeight)
            .overlay {
                if let url = NativeRoutes.external(item["cover_image_url"].text) {
                    AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: {
                        LinearGradient(colors: [.cyan.opacity(0.22), .black], startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                } else {
                    LinearGradient(colors: [.cyan.opacity(0.25), .indigo.opacity(0.3), .black], startPoint: .topLeading, endPoint: .bottomTrailing)
                }
            }
            .overlay {
                LinearGradient(stops: [
                    .init(color: .black.opacity(0.04), location: 0),
                    .init(color: .black.opacity(0.18), location: 0.3),
                    .init(color: .black.opacity(0.72), location: 0.65),
                    .init(color: .black.opacity(0.95), location: 1)
                ], startPoint: .top, endPoint: .bottom)
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(item["title"].text)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                    if !item["excerpt"].text.isEmpty {
                        Text(item["excerpt"].text).font(.caption)
                            .foregroundStyle(.white.opacity(0.8)).lineLimit(2)
                    }
                    if let publishedDate {
                        Text(publishedDate, format: .dateTime.month(.abbreviated).day().year())
                            .font(.caption2).foregroundStyle(.white.opacity(0.6))
                    }
                }.multilineTextAlignment(.leading).padding(22)
            }
            .clipShape(RoundedRectangle(cornerRadius: 24))
            .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.1), lineWidth: 0.5) }
            .accessibilityElement(children: .combine)
    }
}
struct PublicRow: View {
    let kind: PublicSection
    let item: APIValue
    var body: some View { VStack(alignment: .leading, spacing: 8) {
        if kind == .feed, let url = NativeRoutes.external(item["cover_image_url"].text) { AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Rectangle().fill(.cyan.opacity(0.1)) }.frame(height: 160).clipped().clipShape(RoundedRectangle(cornerRadius: 16)) }
        Text(item.text("title", "name")).font(.headline)
        Text(kind == .jobs ? item["company"].text : kind == .directory ? item["kind"].text.capitalized : item["excerpt"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
        if kind == .jobs || kind == .directory { Text([item["location"].text, item["workplace_type"].text, item["seniority"].text].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.cyan) }
        if kind == .directory { Text(item["summary"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
    }.padding(.vertical, 10) }
}
struct PublicDetail: View {
    @EnvironmentObject var session: Session
    let kind: PublicSection
    let item: APIValue
    @State var detail: APIValue = .null
    @State var error = ""
    @State var applyURL: URL?
    @State var loading = true
    var value: APIValue { detail == .null ? item : detail }
    var body: some View { Group {
        if kind == .feed { ArticleReader(item: value, loading: loading, error: error) { Task { await load() } } }
        else { ScrollView { VStack(alignment: .leading, spacing: 20) {
        Text(value.text("title", "name")).font(.largeTitle.bold())
        if kind == .jobs {
            Text(value["company"].text).font(.title3)
            Text([value["location"].text, value["workplace_type"].text, value["seniority"].text].filter { !$0.isEmpty }.joined(separator: " · ")).foregroundStyle(.secondary)
            MarkdownText(text: value["content"]["requirements_summary"].text)
            Text(value["content"]["tech_stack"].list.map(\.text).joined(separator: " · ")).foregroundStyle(.cyan)
            if let applyURL { Link(destination: applyURL) { Label("Apply on company website", systemImage: "arrow.up.right") }.buttonStyle(.borderedProminent) }
            else if !session.signedIn { Button("Sign in to apply") { session.showAuth = true }.buttonStyle(.borderedProminent) }
            else if session.needsOnboarding { NavigationLink("Complete profile to apply") { OnboardingView() }.buttonStyle(.borderedProminent) }
            else if !loading { Button("Get application link") { Task { await loadApply() } }.buttonStyle(.borderedProminent) }
        } else if kind == .feed {
            if let url = NativeRoutes.external(value["cover_image_url"].text) { AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }.clipShape(RoundedRectangle(cornerRadius: 20)) }
            MarkdownText(text: value.text("body_md", "excerpt"))
        } else {
            Text(value["kind"].text.capitalized).foregroundStyle(.cyan)
            MarkdownText(text: value["summary"].text)
            Text(value["location"].text).foregroundStyle(.secondary)
            ForEach(value["tags"].list.map(\.text), id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
            if let url = NativeRoutes.external(value["website"].text) { Link(destination: url) { Label("Visit website", systemImage: "arrow.up.right") }.buttonStyle(.borderedProminent) }
        }
        if loading { ProgressView() }
        if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(24) } } }.navigationBarTitleDisplayMode(.inline).task { await load() }.task(id: session.signedIn && !session.needsOnboarding) { if kind == .jobs && session.signedIn && !session.needsOnboarding { await loadApply() } } }
    func load() async { loading = true; defer { loading = false }; do {
        let slug = item["slug"].text.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
        if kind == .feed { detail = try await API.shared.call("content/documents/post/" + slug)["document"] }
        else if kind == .directory { detail = try await API.shared.call("directory/" + item["kind"].text + "/" + slug)["entry"] }
        else { detail = try await API.shared.call("job_postings/" + slug); if session.signedIn && !session.needsOnboarding { await loadApply() } }; error = ""
    } catch { self.error = error.localizedDescription } }
    func loadApply() async { do { let result = try await API.shared.call("job_postings/" + item["slug"].text + "/apply"); applyURL = NativeRoutes.external(result["apply_url"].text); if applyURL == nil { error = "The application link is currently unavailable." } } catch { self.error = error.localizedDescription } }
}
struct ArticleTitlePosition: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
struct ArticleReader: View {
    let item: APIValue
    let loading: Bool
    let error: String
    let retry: () -> Void
    @State private var compact = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var imageURL: URL? { NativeRoutes.external(item["cover_image_url"].text) }
    var publishedDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: item["published_at"].text) ?? ISO8601DateFormatter().date(from: item["published_at"].text)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let imageURL {
                    Color.clear.frame(height: 300).overlay {
                        AsyncImage(url: imageURL) { image in image.resizable().scaledToFill() } placeholder: { Rectangle().fill(.white.opacity(0.05)) }
                    }.clipped()
                }
                VStack(alignment: .leading, spacing: 18) {
                    Text(item["title"].text).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
                        .background { GeometryReader { proxy in Color.clear.preference(key: ArticleTitlePosition.self, value: proxy.frame(in: .named("articleScroll")).maxY) } }
                    if !item["excerpt"].text.isEmpty { Text(item["excerpt"].text).font(.subheadline).foregroundStyle(.secondary) }
                    HStack(spacing: 10) {
                        if let url = NativeRoutes.external(item["author"]["avatar_url"].text) {
                            AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.2) }.frame(width: 28, height: 28).clipShape(Circle())
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            if !item["author"]["display_name"].text.isEmpty { Text(item["author"]["display_name"].text).font(.caption.weight(.medium)) }
                            HStack(spacing: 8) {
                                if let publishedDate { Text(publishedDate, format: .dateTime.month(.abbreviated).day().year()) }
                                if case .number(let minutes) = item["meta"]["read_time"], minutes > 0 { Text("· \(Int(minutes)) min read") }
                            }.font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Divider().padding(.vertical, 4)
                    MarkdownText(text: item.text("body_md", "excerpt"))
                    if loading { ProgressView() }
                    if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry", action: retry) }
                }.padding(24).frame(maxWidth: 680, alignment: .leading).frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .coordinateSpace(name: "articleScroll")
        .onPreferenceChange(ArticleTitlePosition.self) { position in
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { compact = position < 0 }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if compact {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 8) {
                        if let imageURL {
                            AsyncImage(url: imageURL) { image in image.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.2) }
                                .frame(width: 30, height: 30).clipShape(RoundedRectangle(cornerRadius: 7))
                        }
                        Text(item["title"].text).font(.caption.weight(.semibold)).lineLimit(1).frame(maxWidth: 210, alignment: .leading)
                    }.accessibilityElement(children: .combine)
                }
            }
        }
    }
}
struct MarkdownText: View {
    let text: String
    var body: some View { VStack(alignment: .leading, spacing: 14) { ForEach(Array(text.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, paragraph in
        if paragraph.hasPrefix("#") { Text(paragraph.trimmingCharacters(in: CharacterSet(charactersIn: "# "))).font(.title3.bold()) }
        else { Text((try? AttributedString(markdown: paragraph, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(paragraph)).lineSpacing(5) }
    } }.textSelection(.enabled) }
}

private struct CatalogMenuSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) { content.padding(.horizontal, 14).padding(.vertical, 9).glassEffect(.regular.interactive(), in: Capsule()) }
        else { content.padding(.horizontal, 14).padding(.vertical, 9).background(.thinMaterial, in: Capsule()) }
    }
}
private struct CatalogMetric: View {
    let value: String
    let label: String
    let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Image(systemName: icon).font(.caption).foregroundStyle(.cyan.opacity(0.8))
            Text(value).font(.system(size: 21, weight: .semibold)).monospacedDigit().foregroundStyle(.white)
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 16)).overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.07)) }
    }
}
private struct CatalogItemCard: View {
    let kind: PublicSection
    let item: APIValue
    var icon: String { kind == .jobs ? "briefcase" : ["company": "building.2", "investor": "chart.line.uptrend.xyaxis", "grant": "gift", "resource": "square.stack.3d.up", "person": "person"][item["kind"].text] ?? "building.2" }
    var salary: String {
        let values = [item["salary_min"], item["salary_max"]].compactMap { value -> Int? in if case .number(let n) = value, n > 0 { return Int(n) }; return nil }
        return Array(Set(values)).sorted().map { "$\(($0 / 1000).formatted())k" }.joined(separator: "–")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(.cyan.opacity(0.8)).frame(width: 38, height: 38).background(.cyan.opacity(0.08), in: RoundedRectangle(cornerRadius: 11))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.text("title", "name")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Text(kind == .jobs ? item["company"].text : item["kind"].text.capitalized).font(.caption).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.3)).padding(.top, 5)
            }
            if kind == .directory && !item["summary"].text.isEmpty { Text(item["summary"].text).font(.caption).foregroundStyle(.white.opacity(0.6)).lineLimit(2).lineSpacing(2) }
            HStack(spacing: 8) {
                Text([item["location"].text, item["workplace_type"].text].filter { !$0.isEmpty }.joined(separator: " · ")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                Spacer(minLength: 3)
                if !salary.isEmpty { Text(salary).font(.caption.weight(.medium)).foregroundStyle(.mint.opacity(0.85)) }
            }
            if kind == .jobs {
                HStack(spacing: 8) {
                    if !item["seniority"].text.isEmpty { Text(item["seniority"].text).font(.system(size: 10)).foregroundStyle(.cyan.opacity(0.8)) }
                    let tools = item["content"]["tech_stack"].list.prefix(3).map(\.text).joined(separator: " · ")
                    if !tools.isEmpty { Text(tools).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1) }
                }
            } else if !item["tags"].list.isEmpty { Text(item["tags"].list.prefix(3).map(\.text).joined(separator: " · ")).font(.system(size: 10)).foregroundStyle(.cyan.opacity(0.75)).lineLimit(1) }
        }.padding(13).background(Color(red: 0.027, green: 0.041, blue: 0.056), in: RoundedRectangle(cornerRadius: 18)).overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.075)) }
    }
}
