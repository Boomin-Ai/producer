import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ManagerSession } from "./cache";
import { UnitComments } from "./UnitComments";
import type { Collection, ContentUnit, ManagerSnapshot, SocialPost, UnitDistribution, UnitPart } from "./contracts";
import { ChannelPostSettings, DEFAULT_CHANNEL_PARAMS, buildChannelOverrides, channelParamsFromPresets, updateChannelPresets, type ChannelParams } from "../../components/ChannelPostSettings";
import { managerFixture } from "./fixtures";
import { OVERVIEW, STAGE_TABS, type ManagerLocation, type ParentLocation, type StageTab, type UnitLocation } from "./navigation";
import { hasTauri, type Channel } from "../../lib/ipc";
import { prefGet, prefSet } from "../../lib/prefs";
import "./manager.css";

const COLLAPSE_PREF = "manager_sidebar_collapsed";
// Restore after universe references, generation, and take selection are connected.
const CLIPS_ENABLED = false;
const ideas = [
  "Turn a strong comment into a reply reel",
  "Share a behind-the-scenes moment",
  "Ask your audience what they want next",
  "Clip a highlight from the last video",
  "Share a quick lesson from today's work",
];
const dateLabel = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
const dateTimeLabel = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(date));
const stageLabel = (stage: ContentUnit["stage"]) => ({ studio: "In production", draft: "Draft", review: "In Review", scheduled: "Scheduled", processing: "Processing", published: "Published", partial: "Partially failed", failed: "Failed" })[stage];
const stageTone = (stage: ContentUnit["stage"]) => stage === "published" ? "success" : stage === "failed" || stage === "partial" ? "danger" : "neutral";
const unitCollection = (unit: ContentUnit, data: ManagerSnapshot) => data.collections.find((c) => c.id === unit.collectionId);
const unitPosts = (unit: ContentUnit, data: ManagerSnapshot) => data.posts.filter((p) => p.unitId === unit.id);
const unitParts = (unit: ContentUnit, data: ManagerSnapshot) => data.parts.filter((part) => part.unitId === unit.id).sort((a, b) => a.index - b.index);
const unitMedia = (unit: ContentUnit, data: ManagerSnapshot) => (data.mediaFiles ?? []).filter((file) => file.unitId === unit.id).sort((a, b) => a.index - b.index);
function previewChannel(id: string, platform: string, handle: string): Channel {
  return { id, platform, display_name: handle.replace(/^@/, ""), external_handle: handle.replace(/^@/, ""), status: "active", endpoint_id: "fixture", endpoint_kind: "connected" };
}
function composerChannels(channels: Channel[], data: ManagerSnapshot): Channel[] {
  if (channels.length) return channels;
  return [...new Map(data.posts.map((post) => [post.integrationId, previewChannel(post.integrationId, post.platform, post.account)])).values()];
}
const overviewViews = [
  { id: "home", label: "Overview" },
  { id: "collections", label: "Collections" },
  { id: "monitor", label: "Monitor" },
] as const;

function SidebarIcon({ kind }: { kind: "overview" | "stages" | "film" | "parts" | "collapse" | "expand" }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.3" /><rect x="14" y="3" width="7" height="7" rx="1.3" /><rect x="3" y="14" width="7" height="7" rx="1.3" /><rect x="14" y="14" width="7" height="7" rx="1.3" /></>,
    stages: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="17" cy="18" r="1.5" fill="currentColor" stroke="none" /></>,
    film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4" /></>,
    parts: <><rect x="4" y="5" width="11" height="13" rx="1.5" /><path d="M9 2h9a2 2 0 0 1 2 2v12m-11 5h9a2 2 0 0 0 2-2v-3" /></>,
    collapse: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18m7-12-3 3 3 3" /></>,
    expand: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18m4-9h5m-2.5-2.5L18 12l-2.5 2.5" /></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

/** Manager presentation shared by the explicit fixture preview and hosted inventory. */
export function ManagerShell({ data: sourceData = managerFixture, channels = [], native = false, initialLocation = OVERVIEW, readOnly = false, onCompose, onUnitSelected, onCreateLibrary, onCreateUnit, onRenameCollection, cacheSession, renderComposer, onLocationChange, headerActions, renderOriginalMedia }: {
  renderOriginalMedia?: (post: SocialPost) => React.ReactNode;
  data?: ManagerSnapshot;
  channels?: Channel[];
  native?: boolean;
  initialLocation?: ManagerLocation;
  headerActions?: React.ReactNode;
  onLocationChange?: (location: ManagerLocation) => void;
  cacheSession?: ManagerSession;
  renderComposer?: (onBack: () => void) => React.ReactNode;
  readOnly?: boolean;
  onCompose?: () => void;
  onUnitSelected?: (unitId: string | null) => void;
  onCreateLibrary?: (kind: "series" | "featured", name: string, requestId: string) => Promise<{ collectionId: string; unitId?: string }>;
  onCreateUnit?: (collectionId: string) => Promise<string>;
  onRenameCollection?: (collectionId: string, name: string) => Promise<void>;
}) {
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createKind, setCreateKind] = useState<"series" | "featured" | null>(null);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createRequestId = useRef(crypto.randomUUID());
  const createMenuRef = useRef<HTMLDivElement>(null);
  const [previewUnits, setPreviewUnits] = useState<ContentUnit[]>([]);
  const [unitEdits, setUnitEdits] = useState<Record<string, Partial<ContentUnit>>>({});
  const [previewParts, setPreviewParts] = useState<UnitPart[]>([]);
  const [partEdits, setPartEdits] = useState<Record<string, Partial<UnitPart>>>({});
  const data = useMemo(() => ({ ...sourceData, units: [...previewUnits, ...sourceData.units].map((unit) => ({ ...unit, ...unitEdits[unit.id] })), parts: [...sourceData.parts, ...previewParts].map((part) => ({ ...part, ...partEdits[part.id] })) }), [previewUnits, sourceData, unitEdits, previewParts, partEdits]);
  const [location, setLocation] = useState<ManagerLocation>(() => {
    if (initialLocation.view === "collection" && !sourceData.collections.some((row) => row.id === initialLocation.collectionId)) return OVERVIEW;
    if ((initialLocation.view === "unit" || initialLocation.view === "part") && !sourceData.units.some((row) => row.id === initialLocation.unitId)) return OVERVIEW;
    if (initialLocation.view === "post" && !sourceData.posts.some((row) => row.id === initialLocation.socialPostId)) return OVERVIEW;
    if (initialLocation.view === "post" && initialLocation.returnTo.view !== "unit") {
      const post = sourceData.posts.find((row) => row.id === initialLocation.socialPostId);
      if (post?.unitId && sourceData.units.some((row) => row.id === post.unitId)) {
        return { view: "unit", unitId: post.unitId, returnTo: initialLocation.returnTo };
      }
    }
    return initialLocation;
  });
  const rootRef = useRef<HTMLElement>(null);
  // Notify the outer app after the layout effect has saved this navigation.
  useEffect(() => { onLocationChange?.(location); }, [location, onLocationChange]);
  const [unitTabs, setUnitTabs] = useState(cacheSession?.navigation?.unitTabs ?? {});
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_PREF) === "1");
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  const [overviewPickerOpen, setOverviewPickerOpen] = useState(false);
  const [previewCollectionId, setPreviewCollectionId] = useState<string | null>(null);
  const collectionPickerRef = useRef<HTMLDivElement>(null);
  const expandedCollectionRef = useRef<HTMLDivElement>(null);
  const overviewPickerRef = useRef<HTMLDivElement>(null);
  const overviewTriggerRef = useRef<HTMLButtonElement>(null);
  const pickerCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overviewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prefLoaded, setPrefLoaded] = useState(() => !hasTauri());
  const [expandedCollectionId, setExpandedCollectionId] = useState<string | null>(() => {
    if (location.view === "collection") return location.collectionId;
    if (location.view === "unit" || location.view === "part") return data.units.find((item) => item.id === location.unitId)?.collectionId ?? null;
    return null;
  });
  const [expandedUnitId, setExpandedUnitId] = useState<string | null>(() => location.view === "unit" || location.view === "part" ? location.unitId : null);
  const [overviewTab, setOverviewTab] = useState<"home" | "collections" | "monitor">(cacheSession?.navigation?.overviewTab ?? "home");
  const scrollKey = JSON.stringify(location) + (location.view === "overview" ? overviewTab : location.view === "unit" ? unitTabs[location.unitId] ?? "overview" : "");
  useLayoutEffect(() => {
    if (!cacheSession || location.view === "compose") return;
    const navigation = { location, overviewTab, unitTabs, scroll: cacheSession.navigation?.scroll ?? {} };
    cacheSession.saveNavigation(navigation);
    const root = rootRef.current;
    if (!root) return;
    const selectors = [".pm-main", ".pm-tree", ".pm-overview-aside", ".pm-overview-body", ".pm-overview-columns", ".pm-unit-columns", ".pm-record-body"];
    const elements = selectors.flatMap((selector) => [...root.querySelectorAll<HTMLElement>(selector)].map((element, index) => ({ element, id: selector + index })));
    for (const { element, id } of elements) {
      const key = id.startsWith(".pm-tree") ? "sidebar" : scrollKey;
      element.scrollTop = navigation.scroll[key]?.[id] ?? 0;
    }
    const saveScroll = (event: Event) => {
      const entry = elements.find(({ element }) => element === event.target);
      if (!entry) return;
      const key = entry.id.startsWith(".pm-tree") ? "sidebar" : scrollKey;
      navigation.scroll[key] = { ...navigation.scroll[key], [entry.id]: entry.element.scrollTop };
      const routes = Object.keys(navigation.scroll);
      if (routes.length > 100) delete navigation.scroll[routes.find((route) => route !== key && route !== "sidebar")!];
      cacheSession.saveNavigation(navigation);
    };
    root.addEventListener("scroll", saveScroll, true);
    return () => root.removeEventListener("scroll", saveScroll, true);
  }, [cacheSession, scrollKey, location, overviewTab, unitTabs]);

  useEffect(() => {
    if (!createMenuOpen) return;
    function dismiss(event: PointerEvent) { if (event.target instanceof Node && !createMenuRef.current?.contains(event.target)) setCreateMenuOpen(false); }
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [createMenuOpen]);
  useEffect(() => {
    if (!createKind || createBusy) return;
    function escape(event: KeyboardEvent) { if (event.key === "Escape") setCreateKind(null); }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [createKind, createBusy]);

  function beginCreate(kind: "series" | "featured") {
    setCreateMenuOpen(false);
    setCreateKind(kind);
    setCreateName("");
    setCreateError(null);
    createRequestId.current = crypto.randomUUID();
  }
  async function createLibrary() {
    if (!createKind || !createName.trim() || !onCreateLibrary || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await onCreateLibrary(createKind, createName.trim(), createRequestId.current);
      setCreateKind(null);
      if (created.unitId) setLocation({ view: "unit", unitId: created.unitId, returnTo: OVERVIEW });
      else { setExpandedCollectionId(created.collectionId); setLocation({ view: "collection", collectionId: created.collectionId }); }
    } catch (error) { setCreateError(String(error)); }
    finally { setCreateBusy(false); }
  }

  useEffect(() => {
    if (!expandedCollectionId || collapsed) return;
    function closeCollection() {
      setExpandedCollectionId(null);
      setExpandedUnitId(null);
    }
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !expandedCollectionRef.current?.contains(event.target)) closeCollection();
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeCollection();
    }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [expandedCollectionId, collapsed]);

  useEffect(() => {
    if (!hasTauri()) return;
    let active = true;
    void prefGet(COLLAPSE_PREF).then((value) => {
      if (!active) return;
      if (value !== null) setCollapsed(value === "1");
      setPrefLoaded(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!prefLoaded) return;
    if (hasTauri()) void prefSet(COLLAPSE_PREF, collapsed ? "1" : "0");
    else localStorage.setItem(COLLAPSE_PREF, collapsed ? "1" : "0");
  }, [collapsed, prefLoaded]);
  useEffect(() => {
    if (!collectionPickerOpen) return;
    function dismiss(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (collectionPickerRef.current?.contains(target) || target.closest(".pm-collection-trigger")) return;
      setCollectionPickerOpen(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setCollectionPickerOpen(false);
    }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [collectionPickerOpen]);
  useEffect(() => {
    if (!overviewPickerOpen) return;
    function dismiss(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (overviewPickerRef.current?.contains(target) || target.closest(".pm-overview-trigger")) return;
      setOverviewPickerOpen(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOverviewPickerOpen(false);
        overviewTriggerRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [overviewPickerOpen]);
  useEffect(() => () => {
    if (pickerCloseTimer.current) clearTimeout(pickerCloseTimer.current);
    if (overviewCloseTimer.current) clearTimeout(overviewCloseTimer.current);
  }, []);

  function cancelPickerClose() {
    if (pickerCloseTimer.current) clearTimeout(pickerCloseTimer.current);
    pickerCloseTimer.current = null;
  }
  function schedulePickerClose() {
    cancelPickerClose();
    pickerCloseTimer.current = setTimeout(() => setCollectionPickerOpen(false), 180);
  }
  function cancelOverviewClose() {
    if (overviewCloseTimer.current) clearTimeout(overviewCloseTimer.current);
    overviewCloseTimer.current = null;
  }
  function scheduleOverviewClose() {
    cancelOverviewClose();
    overviewCloseTimer.current = setTimeout(() => setOverviewPickerOpen(false), 180);
  }
  function openOverviewPicker() {
    cancelOverviewClose();
    setCollectionPickerOpen(false);
    setOverviewPickerOpen(true);
  }

  const selectedUnit = (location.view === "unit" || location.view === "part") ? data.units.find((unit) => unit.id === location.unitId) : undefined;
  const selectedPost = location.view === "post" ? data.posts.find((post) => post.id === location.socialPostId) : undefined;
  const selectedCollection = location.view === "collection" ? data.collections.find((c) => c.id === location.collectionId) : undefined;
  const activeCollectionId = location.view === "collection" ? location.collectionId : selectedUnit?.collectionId ?? null;
  const activeUnitId = selectedUnit?.id ?? null;
  useEffect(() => { onUnitSelected?.(activeUnitId); }, [activeUnitId, onUnitSelected]);

  function openCollection(collectionId: string) {
    const collection = data.collections.find((item) => item.id === collectionId);
    const featuredUnit = collection?.kind === "featured" ? data.units.find((unit) => unit.collectionId === collectionId) : undefined;
    if (featuredUnit) { openUnit(featuredUnit.id, OVERVIEW); return; }
    setExpandedCollectionId(collectionId);
    setLocation({ view: "collection", collectionId });
  }
  function openUnit(unitId: string, returnTo?: ParentLocation) {
    const unit = data.units.find((item) => item.id === unitId);
    if (!unit) return;
    setExpandedUnitId(unitId);
    setLocation({ view: "unit", unitId, returnTo: returnTo ?? (unit.collectionId ? { view: "collection", collectionId: unit.collectionId } : OVERVIEW) });
  }
  function openPost(post: SocialPost, returnTo: ParentLocation | UnitLocation = OVERVIEW) {
    // History and Monitor open the shared unit; its destination links drill into a single post.
    if (returnTo.view !== "unit" && post.unitId && data.units.some((unit) => unit.id === post.unitId)) {
      openUnit(post.unitId, returnTo);
      return;
    }
    setLocation({ view: "post", socialPostId: post.id, returnTo });
    if (post.unitId) {
      const unit = data.units.find((item) => item.id === post.unitId);
      setExpandedUnitId(unit?.id ?? null);
    }
  }
  function openPart(part: UnitPart) {
    const unit = data.units.find((item) => item.id === part.unitId);
    if (!unit) return;
    setExpandedCollectionId(unit.collectionId);
    setExpandedUnitId(unit.id);
    const returnTo = (location.view === "unit" || location.view === "part") && location.unitId === unit.id
      ? location.returnTo
      : unit.collectionId ? { view: "collection" as const, collectionId: unit.collectionId } : OVERVIEW;
    setLocation({ view: "part", partId: part.id, unitId: unit.id, returnTo });
  }
  function createPreviewDraft(draft: { title: string; caption: string; type: string; collectionId: string | null; selectedChannelIds: string[]; distributions: UnitDistribution[]; parts: UnitPart[] }) {
    const { parts, ...fields } = draft;
    const unit: ContentUnit = { id: `preview-${crypto.randomUUID()}`, stage: "draft", partIds: parts.map((part) => part.id), postIds: [], ...fields };
    setPreviewUnits((current) => [unit, ...current]);
    setPreviewParts((current) => [...current, ...parts.map((part) => ({ ...part, unitId: unit.id }))]);
    openUnitAfterCreate(unit);
  }
  function updatePreviewUnit(unitId: string, changes: Partial<ContentUnit>) {
    setUnitEdits((current) => ({ ...current, [unitId]: { ...current[unitId], ...changes } }));
  }
  function createPreviewPart(unit: ContentUnit) {
    const index = unitParts(unit, data).reduce((max, part) => Math.max(max, part.index), 0) + 1;
    const part: UnitPart = { id: `preview-part-${crypto.randomUUID()}`, unitId: unit.id, index, kind: "shot", status: "planned", label: `Clip ${index}`, prompt: "", promptDoc: { text: "", mentions: [] }, source: "generated", takeCount: 0 };
    setPreviewParts((current) => [...current, part]);
    setUnitEdits((current) => ({ ...current, [unit.id]: { ...current[unit.id], partIds: [...unit.partIds, part.id] } }));
    openPart(part);
  }
  function updatePreviewPart(partId: string, changes: Partial<UnitPart>) {
    setPartEdits((current) => ({ ...current, [partId]: { ...current[partId], ...changes } }));
  }
  function openUnitAfterCreate(unit: ContentUnit) {
    setExpandedCollectionId(unit.collectionId);
    setExpandedUnitId(unit.id);
    setLocation({ view: "unit", unitId: unit.id, returnTo: unit.collectionId ? { view: "collection", collectionId: unit.collectionId } : OVERVIEW });
  }

  const staged = useMemo(() => ({
    drafts: data.units.filter((u) => u.stage === "draft"),
    review: data.units.filter((u) => u.stage === "review"),
    scheduled: data.units.filter((u) => u.stage === "scheduled"),
    failed: data.units.filter((u) => u.stage === "failed" || u.stage === "partial"),
    collabs: data.invites.filter((invite) => invite.status === "pending"),
  }), [data]);
  const count = staged.drafts.length + staged.review.length + staged.scheduled.length + staged.failed.length;
  const currentTab = location.view === "stages" ? location.tab : "drafts";
  function showOverviewTab(tab: "home" | "collections" | "monitor") {
    setOverviewTab(tab);
    setLocation(OVERVIEW);
    setCollectionPickerOpen(false);
    setOverviewPickerOpen(false);
  }

  return (
    <section ref={rootRef} className={`pm${native ? " pm-native" : ""}`} aria-label="Manager">
      <aside className={`pm-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Collections sidebar">
        <div className="pm-sidebar-head" data-tauri-drag-region>
          {!collapsed && <div className="pm-overview-switch" aria-label="Overview views">
            {overviewViews.map((view) => <button type="button" key={view.id} className={`pm-overview-switch-button ${view.id === overviewTab ? "active" : ""}`} onClick={() => showOverviewTab(view.id)} aria-label={view.label} aria-current={location.view === "overview" && view.id === overviewTab ? "page" : undefined} title={view.id === overviewTab ? undefined : view.label}>{view.id === "collections" ? <SidebarIcon kind="film" /> : view.id === "monitor" ? <span className="pm-switch-symbol" aria-hidden="true">⌁</span> : <SidebarIcon kind="overview" />}{view.id === overviewTab && <span>{view.label}</span>}</button>)}
          </div>}
          <button type="button" className="pm-icon-button" onClick={() => { setCollectionPickerOpen(false); setOverviewPickerOpen(false); setCollapsed((value) => !value); }} aria-label={collapsed ? "Expand collections sidebar" : "Collapse collections sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}><SidebarIcon kind={collapsed ? "expand" : "collapse"} /></button>
        </div>
        {collapsed ? (
          <div className="pm-collapsed-nav">
            <button type="button" ref={overviewTriggerRef} title="Overview" aria-label="Overview views" aria-haspopup="menu" aria-expanded={overviewPickerOpen} className={`pm-overview-trigger ${location.view === "overview" ? "active" : ""}`} onMouseEnter={openOverviewPicker} onMouseLeave={scheduleOverviewClose} onClick={openOverviewPicker}><SidebarIcon kind="overview" /></button>
            <button type="button" title="Stages" aria-label="Stages" className={location.view === "stages" ? "active" : ""} onClick={() => { setCollectionPickerOpen(false); setLocation({ view: "stages", tab: "drafts" }); }}><SidebarIcon kind="stages" /></button>
            <button type="button" title="Collections" aria-label="Collections" aria-haspopup="dialog" aria-expanded={collectionPickerOpen} className={`pm-collection-trigger ${activeCollectionId || collectionPickerOpen ? "active" : ""}`} onMouseEnter={() => { cancelPickerClose(); setOverviewPickerOpen(false); setCollectionPickerOpen(true); }} onMouseLeave={schedulePickerClose} onFocus={() => setCollectionPickerOpen(true)} onClick={() => setCollectionPickerOpen((value) => !value)}><SidebarIcon kind="film" /></button>
          </div>
        ) : (
          <>
            <div className="pm-sidebar-nav">
              <button type="button" className={`pm-nav-row ${location.view === "stages" ? "active" : ""}`} onClick={() => setLocation({ view: "stages", tab: "drafts" })}><SidebarIcon kind="stages" /><span>Stages</span><span className="pm-count">{count}</span></button>
            </div>
            <div className="pm-sidebar-label">COLLECTIONS</div>
            <div className="pm-tree">
              {data.collections.map((collection) => {
                const expanded = collection.kind !== "featured" && expandedCollectionId === collection.id;
                const units = data.units.filter((unit) => unit.collectionId === collection.id);
                return <div key={collection.id} ref={expanded ? expandedCollectionRef : undefined} className="pm-tree-group">
                  <div className={`pm-tree-collection ${activeCollectionId === collection.id ? "selected" : ""}`}>
                    <button type="button" className={`pm-tree-icon ${expanded ? "expanded" : ""}`} aria-label={collection.kind === "featured" ? `Open ${collection.name}` : `${expanded ? "Collapse" : "Expand"} ${collection.name}`} aria-expanded={collection.kind === "featured" ? undefined : expanded} onClick={() => collection.kind === "featured" ? openCollection(collection.id) : setExpandedCollectionId(expanded ? null : collection.id)}><SidebarIcon kind="film" /></button>
                    <button type="button" className="pm-tree-name" onClick={() => openCollection(collection.id)}><span>{collection.name}</span></button>
                  </div>
                  {expanded && units.length > 0 && <div className="pm-tree-children">{units.map((unit) => {
                    const unitExpanded = expandedUnitId === unit.id;
                    const parts = CLIPS_ENABLED ? unitParts(unit, data) : [];
                    return <div key={unit.id}>
                      <div className={`pm-tree-unit ${activeUnitId === unit.id ? "selected" : ""}`}>
                        {parts.length > 0 ? <button type="button" className={`pm-tree-icon ${unitExpanded ? "expanded" : ""}`} aria-label={`${unitExpanded ? "Collapse" : "Expand"} clips of ${unit.title}`} aria-expanded={unitExpanded} onClick={() => setExpandedUnitId(unitExpanded ? null : unit.id)}><SidebarIcon kind="parts" /></button> : <span className="pm-tree-icon-spacer" />}
                        <button type="button" className="pm-tree-unit-name" onClick={() => openUnit(unit.id)} title={unit.title}>{unit.title}</button>
                        <span className={`pm-stage-dot ${stageTone(unit.stage)}`} title={stageLabel(unit.stage)} />
                      </div>
                      {unitExpanded && parts.length > 0 && <div className="pm-tree-parts">{parts.map((part) => <button type="button" key={part.id} className={`pm-tree-part ${location.view === "part" && location.partId === part.id ? "selected" : ""}`} onClick={() => openPart(part)}><span>{String(part.index).padStart(2, "0")}</span><span>{part.label}</span><i className={`pm-stage-dot ${part.status === "ready" ? "success" : part.status === "failed" ? "danger" : "warning"}`} /></button>)}</div>}
                    </div>;
                  })}</div>}
                </div>;
              })}
            </div>
          </>
        )}
        {onCreateLibrary && <div className="pm-sidebar-create" ref={createMenuRef}>
          <button type="button" className="pm-sidebar-plus" aria-label="Create content" aria-expanded={createMenuOpen} aria-haspopup="menu" onClick={() => setCreateMenuOpen((open) => !open)}>＋</button>
          {createMenuOpen && <div className="pm-sidebar-create-menu" role="menu" aria-label="Create content"><button type="button" role="menuitem" onClick={() => beginCreate("series")}>New series</button><button type="button" role="menuitem" onClick={() => beginCreate("featured")}>New featured unit</button></div>}
        </div>}
      </aside>
      {collapsed && overviewPickerOpen && <div className="pm-overview-popover is-collapsed" ref={overviewPickerRef} role="menu" aria-label="Overview views" onMouseEnter={cancelOverviewClose} onMouseLeave={scheduleOverviewClose}>
        <div className="pm-overview-popover-head">OVERVIEW</div>
        <button type="button" role="menuitem" className={location.view === "overview" && overviewTab === "home" ? "active" : ""} onClick={() => showOverviewTab("home")}><span>⌂</span>Home</button>
        <button type="button" role="menuitem" className={location.view === "overview" && overviewTab === "collections" ? "active" : ""} onClick={() => showOverviewTab("collections")}><SidebarIcon kind="film" />Series</button>
        <button type="button" role="menuitem" className={location.view === "overview" && overviewTab === "monitor" ? "active" : ""} onClick={() => showOverviewTab("monitor")}><span>⌁</span>Monitor</button>
      </div>}
      {collapsed && collectionPickerOpen && <div className="pm-collection-popover" ref={collectionPickerRef} role="dialog" aria-label="Collections" onMouseEnter={cancelPickerClose} onMouseLeave={schedulePickerClose}>
        <div className="pm-collection-popover-head">Collections</div>
        <div className="pm-collection-popover-content">
          <div className="pm-collection-popover-list">{data.collections.map((collection) => {
            const units = data.units.filter((unit) => unit.collectionId === collection.id);
            const previewed = previewCollectionId === collection.id;
            return <div key={collection.id} className={`pm-popover-collection ${previewed ? "previewed" : ""}`} onMouseEnter={() => setPreviewCollectionId(collection.id)} onFocus={() => setPreviewCollectionId(collection.id)}>
              <button type="button" className={`pm-popover-item ${activeCollectionId === collection.id ? "active" : ""}`} onClick={() => { openCollection(collection.id); setCollectionPickerOpen(false); }} title={collection.name}><SidebarIcon kind="film" /><span>{collection.name}</span></button>
              <button type="button" className="pm-popover-disclosure" aria-label={`Show units in ${collection.name}`} aria-expanded={previewed} onClick={() => setPreviewCollectionId(previewed ? null : collection.id)}><small>{units.length}</small><span aria-hidden="true">›</span></button>
            </div>;
          })}</div>
          <div className="pm-collection-preview" aria-live="polite">{(() => {
            const collection = data.collections.find((item) => item.id === previewCollectionId);
            if (!collection) return <p className="pm-preview-hint">Hover over a collection to see its content.</p>;
            const units = data.units.filter((unit) => unit.collectionId === collection.id);
            return <>
              <div className="pm-collection-preview-head"><strong>{collection.name}</strong><small>{units.length} {units.length === 1 ? "unit" : "units"}</small></div>
              {units.length ? units.map((unit) => {
                const parts = CLIPS_ENABLED ? unitParts(unit, data) : [];
                const unitExpanded = expandedUnitId === unit.id;
                return <div key={unit.id} className="pm-preview-unit-group">
                  <div className="pm-popover-unit">
                    <button type="button" className={`pm-popover-item ${activeUnitId === unit.id ? "active" : ""}`} onClick={() => { openUnit(unit.id); setCollectionPickerOpen(false); }} title={unit.title}><span>{unit.title}</span><i className={`pm-stage-dot ${stageTone(unit.stage)}`} /></button>
                    {parts.length > 0 && <button type="button" className="pm-popover-disclosure" aria-label={`${unitExpanded ? "Hide" : "Show"} clips of ${unit.title}`} aria-expanded={unitExpanded} onClick={() => setExpandedUnitId(unitExpanded ? null : unit.id)}><span aria-hidden="true">›</span></button>}
                  </div>
                  {unitExpanded && parts.length > 0 && <div className="pm-popover-parts">{parts.map((part) => <button type="button" key={part.id} className={`pm-popover-item ${location.view === "part" && location.partId === part.id ? "active" : ""}`} onClick={() => { openPart(part); setCollectionPickerOpen(false); }}><small>{String(part.index).padStart(2, "0")}</small><span>{part.label}</span></button>)}</div>}
                </div>;
              }) : <p className="pm-preview-hint">No content in this collection yet.</p>}
            </>;
          })()}</div>
        </div>
      </div>}
      <main key={location.view === "unit" || location.view === "part" ? "unit-" + location.unitId : location.view} className={"pm-main" + (["unit", "compose", "part", "post"].includes(location.view) ? " pm-main-editor" : "")}>
        {location.view === "overview" && <Overview headerActions={headerActions} data={data} tab={overviewTab} onStage={(tab) => setLocation({ view: "stages", tab })} onOpenPost={openPost} onOpenUnit={(id) => openUnit(id, OVERVIEW)} onCollection={openCollection} onCompose={renderComposer ? () => setLocation({ view: "compose" }) : onCompose ?? (() => setLocation({ view: "compose" }))} />}
        {location.view === "compose" && (renderComposer ? renderComposer(() => setLocation(OVERVIEW)) : <NewPostView data={data} channels={channels} onBack={() => setLocation(OVERVIEW)} onCreate={createPreviewDraft} />)}
        {location.view === "stages" && <Stages data={data} staged={staged} tab={currentTab} onTab={(tab) => setLocation({ view: "stages", tab })} onOpenUnit={(id) => openUnit(id, { view: "stages", tab: currentTab })} />}
        {location.view === "collection" && (selectedCollection ? <CollectionView key={selectedCollection.id} collection={selectedCollection} data={data} onUnit={(id) => openUnit(id, location)} onCreateUnit={onCreateUnit} onRenameCollection={onRenameCollection} /> : <Missing onBack={() => setLocation(OVERVIEW)} />)}
        {(location.view === "unit" || location.view === "part") && (selectedUnit ? <UnitView renderOriginalMedia={renderOriginalMedia} commentsEndpointId={cacheSession?.endpointId} savedTab={unitTabs[selectedUnit.id]} onTab={(tab) => setUnitTabs((previous) => Object.fromEntries([...Object.entries(previous).filter(([id]) => id !== selectedUnit.id), [selectedUnit.id, tab]].slice(-100)))} readOnly={readOnly} unit={selectedUnit} data={data} channels={channels} selectedPart={location.view === "part" ? data.parts.find((part) => part.id === location.partId) : undefined} onUpdate={updatePreviewUnit} onUpdatePart={updatePreviewPart} onCreatePart={() => createPreviewPart(selectedUnit)} onClosePart={() => setLocation({ view: "unit", unitId: selectedUnit.id, returnTo: location.returnTo })} onBack={() => setLocation(location.returnTo)} onPart={openPart} onPost={(post) => openPost(post, { view: "unit", unitId: selectedUnit.id, returnTo: location.returnTo })} /> : <Missing onBack={() => setLocation(OVERVIEW)} />)}
        {location.view === "post" && (selectedPost ? <PostView post={selectedPost} data={data} onBack={() => setLocation(location.returnTo)} onUnit={(id) => openUnit(id, location.returnTo.view === "unit" ? location.returnTo.returnTo : location.returnTo)} /> : <Missing onBack={() => setLocation(OVERVIEW)} />)}
      </main>
      {createKind && <div className="pm-create-layer"><button type="button" className="pm-create-scrim" disabled={createBusy} onClick={() => setCreateKind(null)} aria-label="Cancel creation" /><form className="pm-create-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-create-title" onSubmit={(event) => { event.preventDefault(); void createLibrary(); }}><h2 id="pm-create-title">{createKind === "series" ? "New series" : "New featured unit"}</h2><label htmlFor="pm-create-name">Name</label><input id="pm-create-name" autoFocus required maxLength={200} disabled={createBusy} value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={createKind === "series" ? "Name your series" : "Name your featured unit"} />{createError && <p role="alert">{createError}</p>}<footer><button type="button" disabled={createBusy} onClick={() => setCreateKind(null)}>Cancel</button><button type="submit" disabled={createBusy || !createName.trim()}>{createBusy ? "Creating…" : "Create"}</button></footer></form></div>}
    </section>
  );
}

function Missing({ onBack }: { onBack: () => void }) { return <div className="pm-empty"><p>This item is no longer in this workspace.</p><button type="button" onClick={onBack}>Back to overview</button></div>; }
function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "success" | "danger" | "warning" }) { return <span className={`pm-badge ${tone}`}>{children}</span>; }
function MediaArt({ title, index = 1, total = 1, url, video = false, placeholder = true }: { title: string; index?: number; total?: number; url?: string; video?: boolean; placeholder?: boolean }) {
  return <div className="pm-media-art">{url ? (video ? <video src={url} controls playsInline preload="metadata" aria-label={title} /> : <img src={url} alt={title} />) : placeholder ? <div className="pm-art-illustration"><span className="pm-art-city">ATLANTA</span><div className="pm-art-building" /><strong>{title}</strong><small>THE LIST · ATLANTIUM</small></div> : <div className="pm-media-unavailable">No media available</div>}<span className="pm-art-count">{index}/{total}</span></div>;
}
function Overview({ data, tab, onStage, onOpenPost, onOpenUnit, onCollection, onCompose, headerActions }: { headerActions?: React.ReactNode; data: ManagerSnapshot; tab: "home" | "collections" | "monitor"; onStage: (tab: StageTab) => void; onOpenPost: (post: SocialPost) => void; onOpenUnit: (id: string) => void; onCollection: (id: string) => void; onCompose?: () => void }) {
  const published = [...data.posts].filter((post) => post.status === "published").sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
  const scheduled = data.units.filter((unit) => unit.stage === "scheduled").sort((a, b) => Date.parse(a.scheduledAt ?? "") - Date.parse(b.scheduledAt ?? ""));
  const now = Date.now();
  const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
  const publishedThisWeek = published.filter((post) => Date.parse(post.postedAt) >= now - 7 * 24 * 60 * 60 * 1000).length;
  const scheduledThisWeek = scheduled.filter((unit) => {
    const date = Date.parse(unit.scheduledAt ?? "");
    return date >= now && date <= weekFromNow;
  });
  const overdue = scheduled.filter((unit) => Date.parse(unit.scheduledAt ?? "") < now);
  const failedCount = data.units.filter((unit) => unit.stage === "failed" || unit.stage === "partial").length;
  const reviewCount = data.units.filter((unit) => unit.stage === "review").length;
  const needsAttention = failedCount + reviewCount + overdue.length;
  const automationReady = published.filter((post) => post.integrationId && post.mediaId).length;
  const todayPublished = published.filter((post) => new Date(post.postedAt).toDateString() === new Date().toDateString());
  const nextRelease = scheduled.find((unit) => Date.parse(unit.scheduledAt ?? "") >= now);
  const headline = nextRelease ? nextRelease.title + " is next on the schedule." : overdue.length ? "A scheduled release needs attention." : "Nothing is scheduled — give your next post a slot.";
  const healthNotes = [
    failedCount > 0 && `${failedCount} failed ${failedCount === 1 ? "item" : "items"}`,
    overdue.length > 0 && `${overdue.length} overdue ${overdue.length === 1 ? "release" : "releases"}`,
    reviewCount > 0 && `${reviewCount} awaiting review`,
  ].filter(Boolean);
  const healthStatus = healthNotes.length ? healthNotes.join(" · ") : "Publishing is on track";
  return <div className="pm-overview">
    <header className="pm-overview-header" data-tauri-drag-region>
      {tab === "home" ? <>
        <div className="pm-overview-heading">
          <span className="pm-eyebrow">{new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</span>
          <h1>{headline} <span aria-hidden="true">→</span></h1>
          <div className="pm-health-status"><span className={`pm-health-status-dot ${needsAttention ? "warning" : ""}`} /><strong>{healthStatus}</strong></div>
        </div>
        <div className="pm-health-metrics" aria-label="Publishing health">
          <div className="pm-health-metric" title="Published posts in the last 7 days"><span>Published<small>last 7 days</small></span><strong>{publishedThisWeek}</strong></div>
          <button type="button" className="pm-health-metric" title="Scheduled releases in the next 7 days" onClick={() => onStage("scheduled")}><span>Scheduled<small>next 7 days</small></span><strong>{scheduledThisWeek.length}</strong></button>
          <button type="button" className={`pm-health-metric ${needsAttention ? "needs-attention" : ""}`} title="Items awaiting review, failed, or overdue" onClick={() => onStage(failedCount ? "failed" : overdue.length ? "scheduled" : "review")}><span>Attention<small>review · failed</small></span><strong>{needsAttention}</strong></button>
          <div className="pm-health-metric" title="Published posts with an integration and social post ID"><span>Automation-ready<small>post IDs</small></span><strong>{automationReady}</strong></div>
        </div>
      </> : <div className="pm-overview-heading"><span className="pm-eyebrow">MANAGER / OVERVIEW</span><h1>{tab === "collections" ? "Series" : "Monitor"}</h1></div>}
      {headerActions}
    </header>
    {tab === "home" && <div className="pm-overview-columns">
      <aside className="pm-overview-aside">
        <section className="pm-panel pm-releases">
          <h2>TODAY'S RELEASES</h2>
          <div className="pm-release-count">{todayPublished.length}</div>
          {todayPublished.length ? todayPublished.map((post) => <button type="button" className="pm-release-item" key={post.id} onClick={() => onOpenPost(post)}>{post.title}<span>→</span></button>) : <div className="pm-release-empty"><span>Nothing published today.</span>{onCompose && <button type="button" onClick={onCompose} aria-label="Create a post">＋</button>}</div>}
        </section>
        <section className="pm-panel pm-ideas">
          <h2>✧ &nbsp; IDEAS FOR TODAY</h2>
          {ideas.map((idea, index) => <div className="pm-idea" key={idea}><span>{index + 1}</span><p>{idea}</p></div>)}
        </section>
        <section className="pm-panel pm-quick-access">
          <h2>QUICK ACCESS</h2>
          <button type="button" className="pm-quick-link" onClick={() => onStage("drafts")}><span>Drafts</span><small>{data.units.filter((unit) => unit.stage === "draft").length}</small></button>
          <button type="button" className="pm-quick-link" onClick={() => onStage("review")}><span>In review</span><small>{data.units.filter((unit) => unit.stage === "review").length}</small></button>
          <button type="button" className="pm-quick-link" onClick={() => onStage("scheduled")}><span>Scheduled</span><small>{scheduled.length}</small></button>
          {onCompose && <button type="button" className="pm-quick-create" onClick={onCompose}>＋ &nbsp; New post</button>}
        </section>
      </aside>
      <div className="pm-overview-body">
        <div className="pm-table-head"><span>POST</span><span>PLATFORMS</span><span>STATUS</span></div>
        <div className="pm-table-section"><span className="pm-section-dot" /> UPCOMING <small>{scheduled.length}</small></div>
        {scheduled.length ? scheduled.map((unit) => <button type="button" className="pm-post-row" key={unit.id} onClick={() => onOpenUnit(unit.id)}>
          <span className="pm-post-identity"><span className="pm-thumb"><SidebarIcon kind="film" /></span><span><strong>{unit.title}</strong><small>{unit.scheduledAt ? dateTimeLabel(unit.scheduledAt) : "Scheduled"}</small></span></span>
          <span className="pm-platform">{[...new Set(unit.distributions?.map((d) => d.platform) ?? unitPosts(unit, data).map((post) => post.platform))].join(", ") || "—"}</span><Badge>Scheduled</Badge>
        </button>) : <div className="pm-table-empty">Nothing on the schedule. {onCompose && <button type="button" onClick={onCompose}>Schedule a post</button>}</div>}
        <div className="pm-table-section published"><span className="pm-section-dot" /> PUBLISHED HISTORY <small>{published.length}</small></div>
        {published.length === 0 && <div className="pm-table-empty">No published posts in this workspace yet.</div>}
        {published.map((post) => <button type="button" className="pm-post-row" key={post.id} onClick={() => onOpenPost(post)}>
          <span className="pm-post-identity"><span className="pm-thumb">{post.previewUrl ? <img src={post.previewUrl} alt="" loading="lazy" /> : "▶"}</span><span><strong>{post.title}</strong><small>{post.type.replace("-", " ")} · {dateTimeLabel(post.postedAt)}{post.unitId ? "" : " · Unassigned"}</small></span></span>
          <span className="pm-platform">◎ &nbsp; {post.account}</span><Badge tone="success">Published</Badge>
        </button>)}
      </div>
    </div>}
    {tab === "collections" && <div className="pm-overview-alt"><p className="pm-eyebrow">YOUR COLLECTIONS</p><h2>All content, one place</h2><div className="pm-card-grid">{data.collections.map((collection) => <button type="button" className="pm-collection-card" key={collection.id} onClick={() => onCollection(collection.id)}><span className="pm-card-icon"><SidebarIcon kind="film" /></span><strong>{collection.name}</strong><small>{data.units.filter((unit) => unit.collectionId === collection.id).length} items</small></button>)}</div></div>}
    {tab === "monitor" && <div className="pm-overview-alt"><p className="pm-eyebrow">COMMENT MONITOR</p><h2>Posts with conversations</h2><p>Open a post to see its publication identity and comment status.</p><div className="pm-monitor-list">{published.filter((post) => (post.commentCount ?? 0) > 0).map((post) => <button type="button" key={post.id} onClick={() => onOpenPost(post)}><span>{post.title}</span><small>{post.commentCount} comments · {post.account}</small></button>)}</div></div>}
  </div>;
}

function Stages({ data, staged, tab, onTab, onOpenUnit }: { data: ManagerSnapshot; staged: { drafts: ContentUnit[]; review: ContentUnit[]; scheduled: ContentUnit[]; failed: ContentUnit[]; collabs: ManagerSnapshot["invites"] }; tab: StageTab; onTab: (tab: StageTab) => void; onOpenUnit: (id: string) => void }) {
  const count = (id: StageTab) => staged[id].length;
  const units = tab === "collabs" ? [] : staged[tab];
  return <div className="pm-stages"><div className="pm-page-head"><p className="pm-eyebrow">▥ &nbsp; MANAGER / STAGES</p><h1>Stages</h1></div><div className="pm-stage-tabs">{STAGE_TABS.map((item) => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} onClick={() => onTab(item.id)}>{item.label}{count(item.id) > 0 && <span>{count(item.id)}</span>}</button>)}</div>{tab === "collabs" ? <div className="pm-card-grid">{staged.collabs.map((invite) => <article className="pm-stage-card" key={invite.id}><Badge tone="warning">Pending invitation</Badge><div className="pm-stage-card-art">◎</div><div className="pm-stage-card-content"><strong>{invite.title}</strong><p>From {invite.account}</p></div></article>)}{staged.collabs.length === 0 && <div className="pm-empty">No collaboration invitations.</div>}</div> : <div className="pm-card-grid">{units.map((unit) => <button type="button" className="pm-stage-card" key={unit.id} onClick={() => onOpenUnit(unit.id)}><Badge tone={stageTone(unit.stage)}>{stageLabel(unit.stage)}</Badge><div className="pm-stage-card-art">{unit.type === "carousel" ? "▦" : "▷"}</div><div className="pm-stage-card-content"><strong>{unit.title}</strong>{unit.caption && <p>{unit.caption}</p>}<small>{unitCollection(unit, data)?.name ?? "Unfiled"}</small></div></button>)}{units.length === 0 && <div className="pm-empty">Nothing in {STAGE_TABS.find((item) => item.id === tab)?.label.toLowerCase()}.</div>}</div>}</div>;
}

function CollectionView({ collection, data, onUnit, onCreateUnit, onRenameCollection }: { collection: Collection; data: ManagerSnapshot; onUnit: (id: string) => void; onCreateUnit?: (collectionId: string) => Promise<string>; onRenameCollection?: (collectionId: string, name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.name);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  async function saveName() {
    if (!onRenameCollection || saving || !name.trim()) return;
    setSaving(true); setError(null);
    try { await onRenameCollection(collection.id, name.trim()); setEditing(false); pencil.current?.focus(); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  async function addUnit() {
    if (!onCreateUnit || creating) return;
    setCreating(true); setError(null);
    try { onUnit(await onCreateUnit(collection.id)); }
    catch (e) { setError(String(e)); }
    finally { setCreating(false); }
  }
  const units = data.units.filter((unit) => unit.collectionId === collection.id);
  const publishedCount = units.filter((unit) => unit.stage === "published").length;
  const scheduledCount = units.filter((unit) => unit.stage === "scheduled").length;
  return <div className="pm-detail-page pm-collection-page">
    <header className="pm-collection-page-header">
      <span className="pm-collection-page-icon"><SidebarIcon kind="film" /></span>
      <div className="pm-collection-page-identity">
        <p className="pm-eyebrow">MANAGER / COLLECTION</p>
        <div className="pm-collection-title-line">{editing ? <form className="pm-collection-name-form" onSubmit={(event) => { event.preventDefault(); void saveName(); }}><input aria-label="Collection name" autoFocus required maxLength={200} disabled={saving} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !saving) { setEditing(false); pencil.current?.focus(); } }} /><button type="submit" disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save"}</button><button type="button" disabled={saving} onClick={() => { setEditing(false); pencil.current?.focus(); }}>Cancel</button></form> : <><h1>{collection.name}</h1>{onRenameCollection && <button ref={pencil} type="button" className="pm-collection-rename" aria-label="Rename collection" title="Rename collection" onClick={() => { setName(collection.name); setError(null); setEditing(true); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Z M13 6l5 5" /></svg></button>}</>}</div>
        <p className="pm-collection-page-summary">{collection.description || "No description added yet."}</p>
      </div>
      <div className="pm-collection-page-stats" aria-label="Collection status">
        <span><strong>{units.length}</strong> {units.length === 1 ? "unit" : "units"}</span>
        <span><strong>{publishedCount}</strong> published</span>
        <span><strong>{scheduledCount}</strong> scheduled</span>
      </div>
      {onCreateUnit && collection.kind !== "featured" && <button type="button" className="pm-collection-add" aria-label="Create unit in collection" title="New unit" disabled={creating} onClick={() => void addUnit()}>{creating ? "…" : "+"}</button>}
    </header>
    {error && <p className="pm-collection-error" role="alert">{error}</p>}
    <section className="pm-collection-units">
      {units.length ? <div className={"pm-collection-unit-list" + (CLIPS_ENABLED ? "" : " pm-collection-no-clips")}>
        <div className="pm-collection-unit-head"><span>UNIT</span>{CLIPS_ENABLED && <span>CLIPS</span>}<span>POSTS</span><span>DISTRIBUTED ON</span><span>STAGE</span></div>
        {units.map((unit) => {
          const posts = unitPosts(unit, data);
          const accounts = [...new Set(posts.map((post) => post.account))];
          return <button type="button" className="pm-collection-unit-row" key={unit.id} onClick={() => onUnit(unit.id)}>
            <span className="pm-collection-unit-identity"><span className="pm-collection-unit-icon">{unit.type === "carousel" ? "▦" : "▶"}</span><span><strong>{unit.title}</strong><small>{unit.type === "unassigned" ? "No media" : unit.type.replace("-", " ")}{unit.publishedAt ? ` · ${dateLabel(unit.publishedAt)}` : unit.scheduledAt ? ` · ${dateLabel(unit.scheduledAt)}` : ""}</small></span></span>
            {CLIPS_ENABLED && <span className="pm-collection-unit-count">{unitParts(unit, data).length}</span>}
            <span className="pm-collection-unit-count">{posts.length}</span>
            <span className="pm-collection-unit-account">{accounts.length ? accounts.join(", ") : "—"}</span>
            <span><Badge tone={stageTone(unit.stage)}>{stageLabel(unit.stage)}</Badge></span>
          </button>;
        })}
      </div> : <div className="pm-collection-empty">No content in this collection yet.</div>}
    </section>
  </div>;
}

function ChannelAvatar({ label, url }: { label: string; url?: string | null }) {
  return <span className="pm-channel-avatar" aria-hidden="true">{label.replace(/^@/, "")[0]?.toUpperCase() || "?"}{url && <img src={url} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} />}</span>;
}

function NewPostView({ data, channels, onBack, onCreate }: {
  data: ManagerSnapshot;
  channels: Channel[];
  onBack: () => void;
  onCreate: (draft: { title: string; caption: string; type: string; collectionId: string | null; selectedChannelIds: string[]; distributions: UnitDistribution[]; parts: UnitPart[] }) => void;
}) {
  const draftUnitId = useRef("preview-compose-" + crypto.randomUUID());
  const [clips, setClips] = useState<UnitPart[]>([]);
  const [clipsOpen, setClipsOpen] = useState(false);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [caption, setCaption] = useState("");
  const [collectionId, setCollectionId] = useState<string>("");
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [channelParams, setChannelParams] = useState<Record<string, ChannelParams>>({});
  const [expandedChannelIds, setExpandedChannelIds] = useState<Set<string>>(new Set());
  const channelSelectionTouched = useRef(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const channelPickerRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const firstFile = files[0];
  const type = files.length > 1 ? "carousel" : firstFile?.type.startsWith("video/") ? "short-video" : firstFile ? "image" : "unassigned";
  const collection = data.collections.find((item) => item.id === collectionId);
  const availableChannelDetails = useMemo(() => composerChannels(channels, data), [channels, data]);
  const availableChannels = useMemo(() => availableChannelDetails.map((channel) => ({ id: channel.id, platform: channel.platform, label: channel.external_handle ? `@${channel.external_handle.replace(/^@/, "")}` : channel.display_name, avatarUrl: channel.avatar_url })), [availableChannelDetails]);
  const selectedChannelRows = availableChannels.filter((channel) => selectedChannels.has(channel.id));
  const selectedChannelDetails = availableChannelDetails.filter((channel) => selectedChannels.has(channel.id));
  const draftUnit: ContentUnit = { id: draftUnitId.current, title: title.trim() || "Untitled post", caption, type, collectionId: collectionId || null, stage: "draft", partIds: clips.map((clip) => clip.id), postIds: [] };
  const clipData: ManagerSnapshot = { ...data, units: [...data.units, draftUnit], parts: [...data.parts, ...clips] };
  const activeClip = clips.find((clip) => clip.id === activeClipId) ?? clips[0];
  function createClip() {
    const index = clips.reduce((max, clip) => Math.max(max, clip.index), 0) + 1;
    const clip: UnitPart = { id: "preview-part-" + crypto.randomUUID(), unitId: draftUnitId.current, index, kind: "shot", status: "planned", label: "Clip " + index, prompt: "", promptDoc: { text: "", mentions: [] }, source: "generated", takeCount: 0 };
    setClips((current) => [...current, clip]);
    setActiveClipId(clip.id);
    setClipsOpen(true);
  }
  function updateClip(id: string, changes: Partial<UnitPart>) {
    setClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...changes } : clip));
  }

  function patchChannelParams(channelId: string, patch: Partial<ChannelParams>) {
    setChannelParams((current) => ({ ...current, [channelId]: { ...(current[channelId] ?? DEFAULT_CHANNEL_PARAMS), ...patch } }));
  }

  useEffect(() => {
    if (!channelSelectionTouched.current) {
      setSelectedChannels(new Set(availableChannels.map((channel) => channel.id)));
      setExpandedChannelIds(new Set(availableChannels[0] ? [availableChannels[0].id] : []));
    }
  }, [availableChannels]);

  useEffect(() => {
    if (!firstFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(firstFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [firstFile]);
  useEffect(() => {
    if (!channelsOpen) return;
    function closeOnOutside(event: PointerEvent) { if (event.target instanceof Node && !channelPickerRef.current?.contains(event.target)) setChannelsOpen(false); }
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") setChannelsOpen(false); }
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("pointerdown", closeOnOutside); window.removeEventListener("keydown", closeOnEscape); };
  }, [channelsOpen]);

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate({
      title: title.trim() || caption.trim().split(/[.!?\n]/)[0].slice(0, 60) || "Untitled post",
      caption: caption.trim(), type, collectionId: collectionId || null,
      parts: clips,
      selectedChannelIds: selectedChannelDetails.map((channel) => channel.id),
      distributions: selectedChannelDetails.map((channel) => ({ channelId: channel.id, platform: channel.platform, handle: channel.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel.display_name, presets: buildChannelOverrides(channelParams[channel.id] ?? DEFAULT_CHANNEL_PARAMS, channel.platform) })),
    });
  }

  return <form className="pm-new-post" onSubmit={create}>
    <header className={"pm-new-post-bar" + (CLIPS_ENABLED ? " pm-new-post-with-clips" : "")}>
      <button type="button" className="pm-unit-back" onClick={onBack} title="Back to overview" aria-label="Back to overview"><span aria-hidden="true">←</span></button>
      <div className="pm-unit-meta-title pm-new-post-title"><span>NEW POST</span><div className="pm-new-post-title-row">{editingTitle ? <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => setEditingTitle(false)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setEditingTitle(false); } }} placeholder="Untitled post" aria-label="Post title" /> : <h1 title={title.trim() || "Untitled post"}>{title.trim() || "Untitled post"}</h1>}<button type="button" onClick={() => setEditingTitle(true)} title="Edit title" aria-label="Edit title">✎</button></div><select className="pm-new-post-collection-select" value={collectionId} onChange={(event) => setCollectionId(event.target.value)} aria-label="Collection" title={collection?.name ?? "Unfiled"}><option value="">Unfiled</option>{data.collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="pm-unit-meta-field"><span>CONTENT</span><strong>{type === "unassigned" ? "Add media" : type.replace("-", " ")}</strong></div>
      {CLIPS_ENABLED && <div className="pm-unit-meta-field"><span>CLIPS</span><button type="button" className="pm-unit-assets-trigger" onClick={() => setClipsOpen((open) => !open)} aria-expanded={clipsOpen} aria-haspopup="dialog"><strong>{clips.length} {clips.length === 1 ? "clip" : "clips"}</strong><span aria-hidden="true">⌄</span></button></div>}
      <div className="pm-unit-meta-field pm-new-post-channels" ref={channelPickerRef}><span>DISTRIBUTION</span><button type="button" className="pm-new-post-channel-trigger" onClick={() => setChannelsOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={channelsOpen} title="Choose channels"><span className="pm-channel-trigger-content">{selectedChannelRows.length ? <><ChannelAvatar label={selectedChannelRows[0].label} url={selectedChannelRows[0].avatarUrl} /><span className="pm-channel-trigger-name">{selectedChannelRows[0].label}</span>{selectedChannelRows.length > 1 && <span className="pm-channel-more">+{selectedChannelRows.length - 1}</span>}</> : <span className="pm-channel-trigger-name">Choose channels</span>}</span><span className="pm-channel-caret" aria-hidden="true">⌄</span></button>{channelsOpen && <div className="pm-new-post-channel-menu" role="dialog" aria-label="Choose channels"><div className="pm-new-post-channel-menu-head">CHANNELS</div>{availableChannels.length ? availableChannels.map((channel) => <label key={channel.id} className="pm-new-post-channel-option"><input type="checkbox" checked={selectedChannels.has(channel.id)} onChange={() => { channelSelectionTouched.current = true; setSelectedChannels((current) => { const next = new Set(current); if (next.has(channel.id)) next.delete(channel.id); else next.add(channel.id); return next; }); }} /><ChannelAvatar label={channel.label} url={channel.avatarUrl} /><span><strong>{channel.label}</strong><small>{channel.platform}</small></span></label>) : <p>No connected channels in this workspace.</p>}</div>}</div>
      <div className="pm-unit-meta-field"><span>STAGE</span><strong><Badge>Draft</Badge></strong></div>
    </header>
    <div className="pm-new-post-body">
      <aside className="pm-new-post-preview">
        <div className="pm-new-post-preview-head"><span>MEDIA</span><small>{files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "No files"}</small></div>
        <input ref={filePickerRef} type="file" accept="image/*,video/*" multiple className="pm-new-post-file-input" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} aria-label="Add media files" />
        <div className="pm-new-post-media-frame">{previewUrl ? firstFile.type.startsWith("video/") ? <video src={previewUrl} controls /> : <img src={previewUrl} alt="Selected media preview" /> : <div className="pm-new-post-media-empty"><span aria-hidden="true">＋</span><strong>No media yet</strong><small>Add images or a video to set the post format.</small></div>}{files.length > 1 && <span className="pm-new-post-media-count">1/{files.length}</span>}</div>
        <div className="pm-new-post-media-actions"><button type="button" onClick={() => filePickerRef.current?.click()}>{files.length ? "Replace media" : "Add media"}</button>{files.length > 0 && <button type="button" onClick={() => { setFiles([]); if (filePickerRef.current) filePickerRef.current.value = ""; }}>Remove</button>}</div>
      </aside>
      <div className="pm-new-post-editor">
        <div className="pm-new-post-intro"><div><p className="pm-eyebrow">CREATE CONTENT</p><h2>New post</h2></div><button type="submit" className="pm-new-post-save">Create draft preview</button></div>
        <section className="pm-new-post-card"><h3>CAPTION</h3><label className="pm-new-post-field"><textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write your caption…" rows={8} aria-label="Caption" /></label></section>
        <section className="pm-new-post-card pm-post-targets"><h3>POST SETTINGS <small>{selectedChannelDetails.length} {selectedChannelDetails.length === 1 ? "channel" : "channels"}</small></h3>{selectedChannelDetails.length ? <div className="channel-cards">{selectedChannelDetails.map((channel) => <ChannelPostSettings key={channel.id} channel={channel} params={channelParams[channel.id] ?? DEFAULT_CHANNEL_PARAMS} expanded={expandedChannelIds.has(channel.id)} onToggle={() => setExpandedChannelIds((current) => { const next = new Set(current); if (next.has(channel.id)) next.delete(channel.id); else next.add(channel.id); return next; })} onPatch={(patch) => patchChannelParams(channel.id, patch)} onRemove={() => { channelSelectionTouched.current = true; setSelectedChannels((current) => { const next = new Set(current); next.delete(channel.id); return next; }); }} />)}</div> : <p className="pm-post-targets-empty">Choose a channel in the Distribution bar to configure its post.</p>}</section>
      </div>
    </div>
    {CLIPS_ENABLED && clipsOpen && (activeClip ? <PartPanel unit={draftUnit} part={activeClip} data={clipData} onClose={() => setClipsOpen(false)} onPart={(clip) => setActiveClipId(clip.id)} onUpdate={updateClip} onCreate={createClip} /> : <EmptyPartsDropdown unit={draftUnit} onClose={() => setClipsOpen(false)} onCreate={createClip} />)}
  </form>;
}

function UnitView({ renderOriginalMedia, commentsEndpointId, readOnly = false, unit, data, channels, savedTab, onTab, selectedPart, onUpdate, onUpdatePart, onCreatePart, onClosePart, onBack, onPart, onPost }: {
  unit: ContentUnit;
  data: ManagerSnapshot;
  channels: Channel[];
  readOnly?: boolean;
  renderOriginalMedia?: (post: SocialPost) => React.ReactNode;
  commentsEndpointId?: string;
  savedTab?: "overview" | "insights" | "comments";
  onTab?: (tab: "overview" | "insights" | "comments") => void;
  selectedPart?: UnitPart;
  onUpdate: (unitId: string, changes: Partial<ContentUnit>) => void;
  onUpdatePart: (partId: string, changes: Partial<UnitPart>) => void;
  onCreatePart: () => void;
  onClosePart: () => void;
  onBack: () => void;
  onPart: (part: UnitPart) => void;
  onPost: (post: SocialPost) => void;
}) {
  const [localTab, setLocalTab] = useState<"overview" | "insights" | "comments">("overview");
  const tab = savedTab ?? localTab;
  const setTab = (value: typeof tab) => { setLocalTab(value); onTab?.(value); };
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [expandedPostIds, setExpandedPostIds] = useState<Set<string>>(new Set());
  const [channelsOpen, setChannelsOpen] = useState(false);
  const channelPickerRef = useRef<HTMLDivElement>(null);
  const collection = unitCollection(unit, data);
  const posts = unitPosts(unit, data);
  const parts = unitParts(unit, data);
  const mediaFiles = unitMedia(unit, data);
  const isCarousel = unit.type === "carousel";
  const selectedMedia = mediaFiles.find((file) => file.id === selectedMediaId) ?? mediaFiles[0];
  const publishedPosts = posts.filter((post) => post.status === "published");
  const isLocked = readOnly || unit.stage === "review" || unit.stage === "scheduled" || unit.stage === "processing" || unit.stage === "published" || unit.stage === "partial";
  const hasPublishedPosts = publishedPosts.length > 0;
  const knownComments = publishedPosts.filter((post) => post.commentCount !== undefined);
  const commentCount = knownComments.reduce((total, post) => total + (post.commentCount ?? 0), 0);
  const distributions = unit.distributions ?? [];
  const selectedIds = [...new Set([...(unit.selectedChannelIds ?? distributions.map((item) => item.channelId)), ...posts.map((post) => post.integrationId)])];
  const postChannels = selectedIds.map((id) => {
    const distribution = distributions.find((item) => item.channelId === id);
    const post = posts.find((item) => item.integrationId === id);
    return channels.find((channel) => channel.id === id) ?? previewChannel(id, distribution?.platform ?? post?.platform ?? "channel", distribution?.handle ?? post?.account ?? "Connected channel");
  });
  const connectedOptions = composerChannels(channels, data);
  const channelOptions = [...connectedOptions, ...postChannels.filter((channel) => !connectedOptions.some((item) => item.id === channel.id))];
  const channelRows = postChannels.map((channel) => ({ id: channel.id, label: channel.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel.display_name, avatarUrl: channel.avatar_url }));
  const postTargets = [
    ...posts.map((post) => ({ key: post.id, channel: postChannels.find((channel) => channel.id === post.integrationId) ?? previewChannel(post.integrationId, post.platform, post.account), post })),
    ...postChannels.filter((channel) => !posts.some((post) => post.integrationId === channel.id)).map((channel) => ({ key: "target-" + channel.id, channel, post: null })),
  ];
  useEffect(() => {
    setExpandedPostIds(new Set(postTargets[0] ? [postTargets[0].key] : []));
  }, [unit.id, postTargets[0]?.key]);
  function updateChannelSettings(channel: Channel, patch: Partial<ChannelParams>) {
    const existing = distributions.find((item) => item.channelId === channel.id);
    const params = { ...channelParamsFromPresets(existing?.presets), ...patch };
    const next: UnitDistribution = { channelId: channel.id, platform: channel.platform, handle: channel.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel.display_name, presets: updateChannelPresets(existing?.presets, params, channel.platform) };
    onUpdate(unit.id, { distributions: [...distributions.filter((item) => item.channelId !== channel.id), next] });
  }
  function toggleDistribution(id: string) {
    const nextIds = selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id];
    const nextDistributions = nextIds.map((item) => distributions.find((distribution) => distribution.channelId === item) ?? (() => {
      const channel = channelOptions.find((candidate) => candidate.id === item);
      return { channelId: item, platform: channel?.platform ?? "channel", handle: channel?.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel?.display_name ?? "Connected channel", presets: {} };
    })());
    onUpdate(unit.id, { selectedChannelIds: nextIds, distributions: nextDistributions });
  }
  useEffect(() => {
    if (!channelsOpen) return;
    function dismiss(event: PointerEvent) { if (event.target instanceof Node && !channelPickerRef.current?.contains(event.target)) setChannelsOpen(false); }
    function dismissOnEscape(event: KeyboardEvent) { if (event.key === "Escape") setChannelsOpen(false); }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", dismissOnEscape); };
  }, [channelsOpen]);
  const stageDate = unit.stage === "scheduled" && unit.scheduledAt ? dateTimeLabel(unit.scheduledAt) : unit.stage === "published" && unit.publishedAt ? dateLabel(unit.publishedAt) : null;
  const mediaUrl = selectedMedia?.url ?? publishedPosts.find((post) => post.previewUrl)?.previewUrl ?? parts.find((part) => part.mediaUrl)?.mediaUrl;
  const assetsOpen = assetMenuOpen || !!selectedPart;
  function closeAssets() {
    setAssetMenuOpen(false);
    if (selectedPart) onClosePart();
  }
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "insights", label: "Insights" },
    { id: "comments", label: "Comments" },
  ] as const;

  return <div className="pm-unit">
    <header className={"pm-unit-meta-bar" + (CLIPS_ENABLED ? " pm-unit-with-assets" : "")}>
      <button type="button" className="pm-unit-back" onClick={onBack} title={"Back to " + (collection?.name ?? "Overview")} aria-label={"Back to " + (collection?.name ?? "Overview")}><span aria-hidden="true">←</span></button>
      <div className="pm-unit-meta-field">
        <strong>{unit.recording ? "Recording" : unit.type}</strong>
        {isLocked ? <small title={collection?.name ?? "Unfiled"}>{collection?.name ?? "Unfiled"}</small> : <select className="pm-unit-collection-select" value={unit.collectionId ?? ""} onChange={(event) => onUpdate(unit.id, { collectionId: event.target.value || null })} aria-label="Collection"><option value="">Unfiled</option>{data.collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {isLocked && <span className="pm-meta-lock">Locked</span>}
      </div>
      {CLIPS_ENABLED && <div className="pm-unit-meta-field pm-unit-assets-field"><span>CLIPS</span><button type="button" className="pm-unit-assets-trigger" onClick={() => assetsOpen ? closeAssets() : setAssetMenuOpen(true)} aria-expanded={assetsOpen} aria-haspopup="dialog"><strong>{parts.length} {parts.length === 1 ? "clip" : "clips"}</strong><span aria-hidden="true">⌄</span></button></div>}
      <div className="pm-unit-meta-field pm-unit-distribution" ref={channelPickerRef}>
        <span>{hasPublishedPosts ? "DISTRIBUTED ON" : "DISTRIBUTION"}</span>
        {isLocked ? (channelRows.length ? <div className="pm-unit-channel-list">{channelRows.slice(0, 2).map((channel) => <span className="pm-unit-channel" key={channel.id}><ChannelAvatar label={channel.label} url={channel.avatarUrl} /><span title={channel.label}>{channel.label}</span></span>)}{channelRows.length > 2 && <span className="pm-channel-more">+{channelRows.length - 2}</span>}</div> : <strong className="pm-muted">No channels selected</strong>) : <button type="button" className="pm-new-post-channel-trigger" onClick={() => setChannelsOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={channelsOpen} aria-label="Choose distribution channels"><span className="pm-channel-trigger-content">{channelRows.length ? <><ChannelAvatar label={channelRows[0].label} url={channelRows[0].avatarUrl} /><span className="pm-channel-trigger-name">{channelRows[0].label}</span>{channelRows.length > 1 && <span className="pm-channel-more">+{channelRows.length - 1}</span>}</> : <span>Choose channels</span>}</span><span className="pm-channel-caret" aria-hidden="true">⌄</span></button>}
        {channelsOpen && !isLocked && <div className="pm-new-post-channel-menu" role="dialog" aria-label="Distribution channels"><div className="pm-new-post-channel-menu-head">CHANNELS</div>{channelOptions.length ? channelOptions.map((channel) => <label key={channel.id} className="pm-new-post-channel-option"><input type="checkbox" checked={selectedIds.includes(channel.id)} onChange={() => toggleDistribution(channel.id)} /><ChannelAvatar label={channel.display_name} url={channel.avatar_url} /><span><strong>{channel.external_handle ? "@" + channel.external_handle.replace(/^@/, "") : channel.display_name}</strong></span></label>) : <p>No connected channels in this workspace.</p>}</div>}
        {isLocked && <span className="pm-meta-lock">Locked</span>}
      </div>
      <div className="pm-unit-meta-field">
        <span>AUTOMATION</span>
        {hasPublishedPosts ? <strong className="pm-muted">{data.source === "hosted" ? "—" : "No automation attached"}</strong> : <strong className="pm-muted">Available after publishing</strong>}
      </div>
      <div className="pm-unit-meta-field">
        <span>STAGE</span>
        <strong><Badge tone={stageTone(unit.stage)}>{stageLabel(unit.stage)}</Badge></strong>
        {stageDate && <small>{stageDate}</small>}
      </div>
    </header>
    <div className="pm-unit-columns">
      <div className="pm-unit-preview">
        <MediaArt title={selectedMedia?.name ?? unit.title} index={selectedMedia ? mediaFiles.indexOf(selectedMedia) + 1 : 1} total={Math.max(1, mediaFiles.length)} url={mediaUrl} video={selectedMedia?.type === "video"} placeholder={data.source !== "hosted"} />
        {isCarousel && mediaFiles.length > 0 && <nav className="pm-unit-media-rail" aria-label="Carousel media">{mediaFiles.map((file) => <button type="button" key={file.id} className={file.id === selectedMedia?.id ? "active" : ""} onClick={() => setSelectedMediaId(file.id)} aria-current={file.id === selectedMedia?.id ? "true" : undefined} title={file.name}>{file.url ? <img src={file.url} alt="" /> : <span>{String(file.index + 1).padStart(2, "0")}</span>}</button>)}</nav>}
        <div className="pm-preview-caption">{unit.title}</div>
        {posts.filter((post) => post.originalMediaAvailable === false).map((post) => <div key={post.id}>{renderOriginalMedia?.(post) ?? <p className="pm-original-media">Original media unavailable from Instagram.</p>}</div>)}
      </div>
      <div className="pm-unit-content">
        <div className="pm-pill-tabs" role="tablist" aria-label="Unit details">
          {tabs.map((item) => <button key={item.id} id={"pm-unit-tab-" + item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls={"pm-unit-panel-" + item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </div>
        <div id={"pm-unit-panel-" + tab} role="tabpanel" aria-labelledby={"pm-unit-tab-" + tab} className="pm-unit-tab-panel">
          {tab === "overview" && <>
            {unit.recording && <section className="pm-info-card"><h2>RECORDING</h2><p>{new Date(unit.recording.started_at).toLocaleString()} · {Math.floor(unit.recording.duration_ms / 60000)}:{String(Math.floor(unit.recording.duration_ms / 1000) % 60).padStart(2, "0")} · {unit.recording.localAvailable ? "Local" : unit.recording.storageStatus === "synced" ? "Synced" : "Local on the recording device"}</p></section>}
            <section className="pm-info-card"><h2>CAPTION</h2><p>{unit.caption || "No caption saved for this unit."}</p></section>
            <section className="pm-info-card pm-unit-post-settings"><h2>INDIVIDUAL POSTS <small>{postTargets.length} {postTargets.length === 1 ? "destination" : "destinations"}</small></h2>
              {postTargets.length ? <div className="channel-cards">{postTargets.map(({ key, channel, post }) => {
                const distribution = distributions.find((item) => item.channelId === channel.id);
                const presets = { ...(post?.presets ?? distribution?.presets) };
                if (post && post.caption !== unit.caption && !("caption" in presets)) presets.caption = post.caption;
                return <div key={key} className="pm-unit-post-target">{post && <div className="pm-unit-post-result"><Badge tone={post.status === "published" ? "success" : post.status === "failed" ? "danger" : "neutral"}>{post.status}</Badge><button type="button" onClick={() => onPost(post)}>View post →</button></div>}<ChannelPostSettings channel={channel} params={channelParamsFromPresets(presets)} expanded={expandedPostIds.has(key)} onToggle={() => setExpandedPostIds((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onPatch={(patch) => updateChannelSettings(channel, patch)} readOnly={isLocked || post?.status === "published"} /></div>;
              })}</div> : <p>Choose a channel in the Distribution bar to configure each post.</p>}
            </section>
          </>}
          {tab === "insights" && (hasPublishedPosts ? <>
            <div className="pm-insights-intro"><h2>Post insights</h2><p>Metrics from published destinations. A dash means the metric has not been synced to Producer.</p></div>
            <div className="pm-insight-grid">
              {[{ label: "Views", value: "—" }, { label: "Reach", value: "—" }, { label: "Likes", value: "—" }, { label: "Comments", value: knownComments.length ? commentCount.toLocaleString() : "—" }, { label: "Shares", value: "—" }].map((metric) => <div className="pm-insight-card" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
            </div>
          </> : <section className="pm-tab-empty"><h2>Insights appear after publishing</h2><p>{unit.stage === "failed" || unit.stage === "partial" ? "No successfully published post is available for this unit." : "Once this unit is published, performance from connected channels will be available."}</p></section>)}
          {tab === "comments" && (hasPublishedPosts ? commentsEndpointId ? <UnitComments endpointId={commentsEndpointId} posts={publishedPosts} /> : <section className="pm-info-card"><h2>COMMENTS</h2><p>No comment text is available in this preview.</p></section> : <section className="pm-tab-empty"><h2>No comments yet</h2><p>Comments become available after a post is published on a connected channel.</p></section>)}
        </div>
      </div>
    </div>
    {CLIPS_ENABLED && assetsOpen && (parts.length ? <PartPanel unit={unit} part={selectedPart ?? parts[0]} data={data} onClose={closeAssets} onPart={onPart} onUpdate={onUpdatePart} onCreate={onCreatePart} /> : <EmptyPartsDropdown unit={unit} onClose={closeAssets} onCreate={onCreatePart} />)}
  </div>;
}

function EmptyPartsDropdown({ unit, onClose, onCreate }: { unit: ContentUnit; onClose: () => void; onCreate: () => void }) {
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose]);
  return <div className="pm-part-panel-layer"><button type="button" className="pm-part-panel-scrim" onClick={onClose} aria-label="Close clips" /><section className="pm-part-panel pm-part-panel-empty" role="dialog" aria-label="Clips"><header className="pm-part-panel-header"><div><span>CLIPS</span><h2>No clips yet</h2><small>{unit.title}</small></div><button type="button" className="pm-part-panel-close" onClick={onClose} aria-label="Close clips">×</button></header><div className="pm-part-panel-empty-body"><p>Create a clip to start its prompt sheet.</p><button type="button" className="pm-part-panel-add" onClick={onCreate}>＋ New clip</button></div></section></div>;
}


function PartPanel({ unit, part, data, onClose, onPart, onUpdate, onCreate }: { unit: ContentUnit; part: UnitPart; data: ManagerSnapshot; onClose: () => void; onPart: (part: UnitPart) => void; onUpdate: (partId: string, changes: Partial<UnitPart>) => void; onCreate?: () => void }) {
  const parts = unitParts(unit, data);
  const document = part.promptDoc?.text ?? part.prompt ?? (typeof part.spec?.action === "string" ? part.spec.action : "");
  const kindLabel = part.kind === "shot" ? "Shot" : part.kind === "slide" ? "Slide" : "Segment";
  const statusLabel = ({ planned: "Planned", working: "In progress", frames_rendering: "Rendering frames", frames_ready: "Frames ready", clip_rendering: "Rendering clip", ready: "Ready", failed: "Failed" } as const)[part.status];
  const selectedMediaUrl = part.clipUrl ?? part.mediaUrl;
  const takeCount = part.takes?.length ?? part.takeCount ?? 0;
  const isNewPreview = part.id.startsWith("preview-part-");
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose]);
  return <div className="pm-part-panel-layer">
    <button type="button" className="pm-part-panel-scrim" onClick={onClose} aria-label="Close prompt sheet" />
    <section className="pm-part-panel" role="dialog" aria-labelledby="pm-part-panel-title">
      <header className="pm-part-panel-header">
        <div><span>CLIPS · {String(part.index).padStart(2, "0")} / {String(parts.length).padStart(2, "0")}</span><h2 id="pm-part-panel-title">{part.label || kindLabel + " " + part.index}</h2><small>{unit.title}</small></div>
        <div className="pm-part-panel-actions">{onCreate && <button type="button" className="pm-part-panel-add" onClick={onCreate}>＋ New clip</button>}<button type="button" className="pm-part-panel-close" onClick={onClose} aria-label="Close prompt sheet" title="Close prompt sheet">×</button></div>
      </header>
      <nav className="pm-part-panel-nav" aria-label="Choose clip">{parts.map((item) => <button type="button" key={item.id} className={item.id === part.id ? "active" : ""} onClick={() => onPart(item)} aria-current={item.id === part.id ? "page" : undefined} title={item.label}><span>{String(item.index).padStart(2, "0")}</span><strong>{item.label}</strong></button>)}</nav>
      <div className="pm-part-panel-scroll">
        <div className="pm-part-panel-sheet-head"><div><p className="pm-eyebrow">PROMPT SHEET / {kindLabel.toUpperCase()} {String(part.index).padStart(2, "0")}</p>{isNewPreview ? <input className="pm-part-title-input" value={part.label} onChange={(event) => onUpdate(part.id, { label: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} aria-label="Clip name" /> : <h3>{part.label}</h3>}</div><Badge tone={part.status === "ready" ? "success" : part.status === "failed" ? "danger" : "neutral"}>{statusLabel}</Badge></div>
        <section className="pm-part-panel-media"><div className="pm-part-section-head"><span>SELECTED MEDIA</span><small>{takeCount} {takeCount === 1 ? "take" : "takes"}</small></div>{part.clipUrl ? <video className="pm-part-video" src={part.clipUrl} controls playsInline aria-label={part.label} /> : selectedMediaUrl ? <MediaArt title={part.label} index={part.index} total={parts.length} url={selectedMediaUrl} /> : <div className="pm-part-empty-media"><strong>No media selected</strong><span>The selected take will appear here when media is available.</span></div>}</section>
        <section className="pm-part-sheet-document"><h3>DOCUMENT</h3>{isNewPreview ? <textarea autoFocus className="pm-part-document-input" value={document} onChange={(event) => onUpdate(part.id, { promptDoc: { text: event.target.value, mentions: [] } })} placeholder="Describe the action, setting, and what this clip should show…" aria-label="Prompt sheet document" /> : document ? <p>{document}</p> : <p className="pm-part-empty-copy">No prompt sheet has been authored for this {kindLabel.toLowerCase()}.</p>}</section>
        <div className="pm-part-sheet-spec"><div><span>TYPE</span><strong>{kindLabel}</strong></div><div><span>SOURCE</span><strong>{part.source === "real" ? "Real footage" : part.source === "generated" ? "Generated" : "—"}</strong></div><div><span>MODEL</span><strong>{part.model ?? "—"}</strong></div><div><span>TAKES</span><strong>{takeCount}</strong></div></div>
      </div>
    </section>
  </div>;
}

function PostView({ post, data, onBack, onUnit }: { post: SocialPost; data: ManagerSnapshot; onBack: () => void; onUnit: (id: string) => void }) {
  const unit = post.unitId ? data.units.find((item) => item.id === post.unitId) : undefined;
  const collection = unit ? unitCollection(unit, data) : undefined;
  const statusTone = post.status === "published" ? "success" : post.status === "failed" ? "danger" : "neutral";
  return <div className="pm-unit pm-record-view">
    <header className="pm-unit-meta-bar" aria-label="Post metadata">
      <button type="button" className="pm-unit-back" onClick={onBack} title="Back to published history" aria-label="Back to published history"><span aria-hidden="true">←</span></button>
      <div className="pm-unit-meta-title"><span>{post.type.toUpperCase()}</span><h1 title={post.title}>{post.title}</h1><small title={collection?.name ?? "Unfiled"}>{collection?.name ?? "Unfiled"}</small></div>
      <div className="pm-unit-meta-field"><span>DISTRIBUTED ON</span><strong>{post.account}</strong><small>{post.platform}</small></div>
      <div className="pm-unit-meta-field"><span>AUTOMATION</span><strong className="pm-muted">{data.source === "hosted" ? "—" : "No automation attached"}</strong></div>
      <div className="pm-unit-meta-field"><span>STAGE</span><strong><Badge tone={statusTone}>{post.status.charAt(0).toUpperCase() + post.status.slice(1)}</Badge></strong><small>{dateLabel(post.postedAt)}</small></div>
    </header>
    <div className="pm-record-body">
      <div className="pm-record-grid">
        <div className="pm-record-preview"><MediaArt title={post.title} url={post.previewUrl ?? post.mediaUrl} video={!post.previewUrl && (post.type === "short-video" || post.type === "long-video")} placeholder={data.source !== "hosted"} /></div>
        <div className="pm-record-detail">
          <section className="pm-info-card"><h2>CAPTION</h2><p>{post.caption || "No caption saved."}</p></section>
          <section className="pm-info-card"><h2>PUBLICATION</h2><p className="pm-identity">Media ID: {post.mediaId}</p>{post.permalink && <a href={post.permalink} target="_blank" rel="noreferrer">Open on {post.platform} ↗</a>}</section>
          <section className="pm-info-card"><h2>UNIT</h2>{unit ? <button type="button" className="pm-inline-row" onClick={() => onUnit(unit.id)}><span>{unit.title}</span><span>View unit →</span></button> : <p>This post has not been assigned to a unit.</p>}</section>
        </div>
      </div>
    </div>
  </div>;
}
