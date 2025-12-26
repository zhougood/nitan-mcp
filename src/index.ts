import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { Logger } from "./util/logger.js";
import { SiteState } from "./site/state.js";
import { getCategoryByName, getCategoryName } from "./tools/categories.js";
import { formatTimestamp } from "./util/timestamp.js";

// Default site configuration
const DEFAULT_SITE = "https://www.uscardforum.com/";
const DEFAULT_TIMEOUT_MS = 15000;

// Define our MCP agent with tools
export class NitanMCP extends McpAgent {
  server = new McpServer({
    name: "Nitan MCP",
    version: "2.0.0",
  });

  // Logger and SiteState are initialized per request context
  private logger = new Logger("info");
  private siteState: SiteState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize SiteState with default configuration
    this.siteState = new SiteState({
      logger: this.logger,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      defaultAuth: { type: "none" },
    });

    // Auto-select the default site
    this.siteState.selectSite(DEFAULT_SITE);
  }

  async init() {
    // Register discourse_search tool
    this.server.tool(
      "discourse_search",
      {
        query: z.string().optional().describe("Search query (optional if filters are provided)"),
        max_results: z.number().int().min(1).max(50).optional().describe("Maximum number of results to return (default: 50, max: 50)"),
        order: z.enum(["relevance", "likes", "latest", "views", "latest_topic"]).optional().describe("Sort order: relevance (default), likes, latest, views, or latest_topic"),
        category: z.string().optional().describe("Category name in Chinese to search within. Examples: 玩卡, 旅行, 理财, 败家, 生活, 法律, 情感, 搬砖, 文艺, 闲聊, 白金, 吵架"),
        author: z.string().optional().describe("Filter results by author username (e.g., 'xxxyyy')"),
        after: z.string().optional().describe("Filter results after this date (format: YYYY-MM-DD, e.g., '2025-10-07')"),
        before: z.string().optional().describe("Filter results before this date (format: YYYY-MM-DD, e.g., '2025-10-08')"),
      },
      async ({ query = "", max_results = 50, order = "relevance", category, author, after, before }) => {
        try {
          const { base, client } = this.siteState.ensureSelectedSite();
          const q = new URLSearchParams();
          q.set("expanded", "true");

          let fullQuery = "";
          if (query) fullQuery = query;
          if (author) fullQuery = `${fullQuery} @${author}`;
          if (after) fullQuery = `${fullQuery} after:${after}`;
          if (before) fullQuery = `${fullQuery} before:${before}`;

          if (category) {
            const categoryInfo = getCategoryByName(category);
            if (categoryInfo) {
              fullQuery = `${fullQuery} category:${categoryInfo.id}`;
            } else {
              return {
                content: [{ type: "text", text: `Category "${category}" not found. Please use a valid Chinese category name.` }],
                isError: true
              };
            }
          }

          if (order !== "relevance") {
            fullQuery = `${fullQuery} order:${order}`;
          }

          q.set("q", fullQuery);

          const data = (await client.get(`/search.json?${q.toString()}`)) as any;
          const topics: any[] = data?.topics || [];
          const posts: any[] = data?.posts || [];

          const topicPostMap = new Map<number, { blurb: string; post_number: number }>();
          for (const post of posts) {
            if (post.topic_id && post.blurb && !topicPostMap.has(post.topic_id)) {
              topicPostMap.set(post.topic_id, {
                blurb: post.blurb,
                post_number: post.post_number || 1
              });
            }
          }

          const items = topics.slice(0, max_results).map((t) => {
            const postInfo = topicPostMap.get(t.id);
            const postNumberSuffix = postInfo?.post_number ? `/${postInfo.post_number}` : "";
            const result: any = {
              topic_id: t.id,
              url: `${base}/t/${t.slug}/${t.id}${postNumberSuffix}`,
              title: t.title
            };
            if (postInfo?.post_number) result.post_number = postInfo.post_number;
            if (postInfo?.blurb) result.blurb = postInfo.blurb;
            return result;
          });

          return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Search failed: ${e?.message || String(e)}` }], isError: true };
        }
      }
    );

    // Register discourse_read_topic tool
    this.server.tool(
      "discourse_read_topic",
      {
        topic_id: z.number().int().positive().describe("The topic ID to read"),
        post_number: z.number().int().positive().optional().describe("Optional specific post number to read"),
        max_posts: z.number().int().min(1).max(100).optional().describe("Maximum number of posts to return (default: 20, max: 100)"),
      },
      async ({ topic_id, post_number, max_posts = 20 }) => {
        try {
          const { base, client } = this.siteState.ensureSelectedSite();

          let path = `/t/${topic_id}.json`;
          if (post_number) {
            path = `/t/${topic_id}/${post_number}.json`;
          }

          const data = (await client.get(path)) as any;
          const topic = data;
          const postStream = topic?.post_stream;
          const posts = postStream?.posts || [];

          const limitedPosts = posts.slice(0, max_posts);

          const result = {
            topic_id: topic.id,
            title: topic.title,
            url: `${base}/t/${topic.slug}/${topic.id}`,
            posts_count: topic.posts_count,
            views: topic.views,
            like_count: topic.like_count,
            category: topic.category_id ? getCategoryName(topic.category_id) : undefined,
            created_at: formatTimestamp(topic.created_at),
            posts: limitedPosts.map((p: any) => ({
              post_number: p.post_number,
              username: p.username,
              created_at: formatTimestamp(p.created_at),
              cooked: p.cooked?.replace(/<[^>]*>/g, '').substring(0, 2000), // Strip HTML and limit length
              like_count: p.like_count,
            }))
          };

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to read topic: ${e?.message || String(e)}` }], isError: true };
        }
      }
    );

    // Register discourse_list_hot_topics tool
    this.server.tool(
      "discourse_list_hot_topics",
      {
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of hot topics to return (default: 10, max: 50)"),
      },
      async ({ limit = 10 }) => {
        try {
          const { base, client } = this.siteState.ensureSelectedSite();
          const data = (await client.get("/hot.json")) as any;

          const list = data?.topic_list ?? data;
          const topics: any[] = Array.isArray(list?.topics) ? list.topics : [];
          const limitedTopics = topics.slice(0, limit);

          const jsonOutput = limitedTopics.map((topic) => ({
            id: topic.id,
            title: topic.title || topic.fancy_title || `Topic ${topic.id}`,
            url: `${base}/t/${topic.slug || topic.id}/${topic.id}`,
            views: topic.views ?? 0,
            posts_count: topic.posts_count ?? 0,
            like_count: topic.like_count ?? 0,
            category: topic.category_id ? getCategoryName(topic.category_id) : undefined,
            tags: topic.tags || [],
            created_at: formatTimestamp(topic.created_at || ""),
          }));

          return { content: [{ type: "text", text: JSON.stringify(jsonOutput, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to fetch hot topics: ${e?.message || String(e)}` }], isError: true };
        }
      }
    );

    // Register discourse_list_top_topics tool
    this.server.tool(
      "discourse_list_top_topics",
      {
        period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly", "all"]).optional().describe("Time period for top topics (default: weekly)"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of topics to return (default: 10, max: 50)"),
      },
      async ({ period = "weekly", limit = 10 }) => {
        try {
          const { base, client } = this.siteState.ensureSelectedSite();
          const data = (await client.get(`/top/${period}.json`)) as any;

          const list = data?.topic_list ?? data;
          const topics: any[] = Array.isArray(list?.topics) ? list.topics : [];
          const limitedTopics = topics.slice(0, limit);

          const jsonOutput = limitedTopics.map((topic) => ({
            id: topic.id,
            title: topic.title || topic.fancy_title || `Topic ${topic.id}`,
            url: `${base}/t/${topic.slug || topic.id}/${topic.id}`,
            views: topic.views ?? 0,
            posts_count: topic.posts_count ?? 0,
            like_count: topic.like_count ?? 0,
            category: topic.category_id ? getCategoryName(topic.category_id) : undefined,
            created_at: formatTimestamp(topic.created_at || ""),
          }));

          return { content: [{ type: "text", text: JSON.stringify(jsonOutput, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to fetch top topics: ${e?.message || String(e)}` }], isError: true };
        }
      }
    );

    // Register discourse_list_user_posts tool
    this.server.tool(
      "discourse_list_user_posts",
      {
        username: z.string().describe("The username to fetch posts for"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of posts to return (default: 20, max: 50)"),
      },
      async ({ username, limit = 20 }) => {
        try {
          const { base, client } = this.siteState.ensureSelectedSite();
          const data = (await client.get(`/user_actions.json?username=${encodeURIComponent(username)}&filter=4,5`)) as any;

          const actions: any[] = data?.user_actions || [];
          const limitedActions = actions.slice(0, limit);

          const jsonOutput = limitedActions.map((action) => ({
            post_id: action.post_id,
            topic_id: action.topic_id,
            title: action.title,
            url: `${base}/t/${action.slug}/${action.topic_id}/${action.post_number}`,
            excerpt: action.excerpt,
            created_at: formatTimestamp(action.created_at || ""),
          }));

          return { content: [{ type: "text", text: JSON.stringify(jsonOutput, null, 2) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to fetch user posts: ${e?.message || String(e)}` }], isError: true };
        }
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return NitanMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return NitanMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
