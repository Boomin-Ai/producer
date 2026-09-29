import { useQueries } from "@tanstack/react-query";
import { managerKeys } from "./cache";
import type { SocialPost } from "./contracts";
import { loadHostedPostComments } from "./hosted";

/** Each destination has its own cache and identity; comments stay in the unit. */
export function UnitComments({ endpointId, posts }: { endpointId: string; posts: SocialPost[] }) {
  const results = useQueries({ queries: posts.map((post) => ({
    queryKey: managerKeys.comments(post.id),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadHostedPostComments(endpointId, post.id, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })) });
  const denied = results.some((query) => /HTTP (401|403)|rejected the token/i.test(String(query.error ?? "")));
  const failed = results.filter((query) => query.isError);
  const loading = results.some((query) => query.isPending);
  const comments = [...new Map(results.flatMap((query) => query.data ?? []).map((comment) => [comment.postId + ":" + comment.commentId, comment])).values()]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const reported = posts.reduce((total, post) => total + (post.commentCount ?? 0), 0);
  if (denied) return <section className="pm-info-card" role="alert"><h2>COMMENTS</h2><p>Access to these comments is unavailable. Refresh your Boomin connection.</p></section>;
  return <section className="pm-info-card pm-comments">
    <div className="pm-comments-header"><h2>COMMENTS <small>{comments.length || ""}</small></h2><button type="button" disabled={results.some((query) => query.isFetching)} onClick={() => { for (const query of results) void query.refetch(); }}>Refresh</button></div>
    {failed.length > 0 && <p role="alert">Couldn’t refresh comments for {failed.length} {failed.length === 1 ? "destination" : "destinations"}. <button type="button" onClick={() => { for (const query of failed) void query.refetch(); }}>Retry</button></p>}
    {loading && <p role="status">Loading comments…</p>}
    {!loading && !failed.length && !comments.length && <p>{reported ? "No comment text is available from Boomin yet." : "No comments yet."}</p>}
    <div className="pm-comment-list">{comments.map((comment) => {
      const post = posts.find((item) => item.id === comment.postId)!;
      const date = new Date(comment.createdAt);
      return <article className="pm-comment" key={comment.postId + ":" + comment.commentId}>
        <span className="pm-comment-avatar" aria-hidden="true">{comment.username[0]?.toUpperCase() ?? "?"}</span>
        <div><div className="pm-comment-heading"><strong>{comment.username}</strong>{Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>}</div><p>{comment.text}</p><small>{post.platform} · {post.account}</small></div>
      </article>;
    })}</div>
  </section>;
}
