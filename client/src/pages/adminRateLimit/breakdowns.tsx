// Rate Limits admin — By User / By IP / Category Overview tab bodies.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Users, Globe, AlertTriangle, BellRing } from "lucide-react";
import { Fragment, useEffect } from "react";
import { type UserMetrics, type AnonymousMetrics, type RateLimitSummary, type UsageAlert, type DbUser, getCategoryColor, formatTime, getUserDisplayName } from "./shared";
import { UserTimeSeriesChart, IpTimeSeriesChart } from "./timeSeries";

export function UserBreakdown({
  users,
  dbUsers,
  alertsByUser,
  expandedUser,
  setExpandedUser,
}: {
  users: UserMetrics[];
  dbUsers: DbUser[];
  alertsByUser: Map<string, UsageAlert[]>;
  expandedUser: string | null;
  setExpandedUser: (id: string | null) => void;
}) {
  if (users.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <ShieldAlert className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p data-testid="text-no-user-events">No authenticated users have been rate-limited yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="list-user-breakdown">
      {users.map((u) => {
        const displayName = getUserDisplayName(u.userId, dbUsers);
        const dbUser = dbUsers.find((du) => du.id === u.userId);
        const isExpanded = expandedUser === u.userId;
        const userAlerts = alertsByUser.get(u.userId) || [];

        return (
          <Card key={u.userId} id={`rl-user-anchor-${u.userId}`} data-testid={`card-user-${u.userId}`} className={userAlerts.length > 0 ? "border-orange-300" : ""}>
            <CardContent className="p-4">
              <div
                className="flex flex-wrap items-center justify-between gap-2 cursor-pointer"
                onClick={() => setExpandedUser(isExpanded ? null : u.userId)}
                data-testid={`button-expand-user-${u.userId}`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-foreground flex flex-wrap items-center gap-2">
                      {displayName}
                      {userAlerts.length > 0 && (
                        <Badge
                          className="bg-orange-100 text-orange-800 text-xs flex items-center gap-1"
                          data-testid={`badge-warning-${u.userId}`}
                        >
                          <BellRing className="w-3 h-3" />
                          {userAlerts.length} warning{userAlerts.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground break-words">
                      {/* Emails are unbreakable tokens; break-all keeps them
                          from widening the page in a 375px card header. */}
                      {dbUser?.email && <span className="break-all">{dbUser.email} · </span>}
                      {dbUser?.role && <Badge variant="outline" className="text-xs mr-1">{dbUser.role}</Badge>}
                      Last hit: {formatTime(u.lastSeen)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-lg font-bold text-foreground" data-testid={`text-blocked-count-${u.userId}`}>{u.totalBlocked}</div>
                    <div className="text-xs text-muted-foreground">blocked</div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(u.categories).map(([cat, count]) => (
                      <Badge key={cat} className={`text-xs ${getCategoryColor(cat)}`} data-testid={`badge-category-${cat}-${u.userId}`}>
                        {cat}: {count}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="mt-4 border-t pt-3">
                  <UserTimeSeriesChart userId={u.userId} displayName={displayName} recentEvents={u.recentEvents} />
                </div>
              )}

              {isExpanded && userAlerts.length > 0 && (
                <div className="mt-4 border-t pt-3">
                  <div className="text-sm font-medium text-orange-800 mb-2 flex items-center gap-1">
                    <BellRing className="w-4 h-4" />
                    Active Warnings
                  </div>
                  <div className="space-y-1">
                    {userAlerts.map((a) => {
                      const pct = Math.round((a.count / a.max) * 100);
                      return (
                        <div
                          key={a.category}
                          className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-orange-50"
                          data-testid={`user-alert-${u.userId}-${a.category}`}
                        >
                          <Badge className={`text-xs ${getCategoryColor(a.category)}`}>{a.category}</Badge>
                          <span className="font-mono">{a.count}/{a.max}</span>
                          <span className="text-orange-700">({pct}%, threshold {a.warningPercent}%)</span>
                          <span className="text-muted-foreground ml-auto">since {formatTime(a.triggeredAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {isExpanded && u.recentEvents.length > 0 && (
                <div className="mt-4 border-t pt-3">
                  <div className="text-sm font-medium text-muted-foreground mb-2">Recent Blocked Requests</div>
                  <div className="space-y-1">
                    {u.recentEvents.map((ev, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-muted/30"
                        data-testid={`event-row-${u.userId}-${idx}`}
                      >
                        <Badge className={`text-xs ${getCategoryColor(ev.category)}`}>{ev.category}</Badge>
                        <span className="font-mono text-muted-foreground">{ev.method}</span>
                        <span className="font-mono truncate flex-1">{ev.path}</span>
                        <span className="text-muted-foreground whitespace-nowrap">{formatTime(ev.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function AnonymousBreakdown({
  anonymous,
  expandedIp,
  setExpandedIp,
}: {
  anonymous: AnonymousMetrics[];
  expandedIp: string | null;
  setExpandedIp: (ip: string | null) => void;
}) {
  useEffect(() => {
    if (expandedIp === null) return;
    const stillExists = anonymous.some((a) => a.ip === expandedIp);
    if (!stillExists) setExpandedIp(null);
  }, [anonymous, expandedIp, setExpandedIp]);

  if (anonymous.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p data-testid="text-no-anon-events">No anonymous IPs have been rate-limited yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2" data-testid="list-anon-breakdown">
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left p-3 font-medium text-muted-foreground">IP Address</th>
                <th className="text-center p-3 font-medium text-muted-foreground">Blocked</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Categories</th>
                <th className="text-right p-3 font-medium text-muted-foreground">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {anonymous.map((a) => {
                const isExpanded = expandedIp === a.ip;
                return (
                  <Fragment key={a.ip}>
                    <tr
                      id={`rl-ip-anchor-${a.ip}`}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/20"
                      onClick={() => setExpandedIp(isExpanded ? null : a.ip)}
                      data-testid={`row-anon-${a.ip}`}
                    >
                      <td className="p-3 font-mono text-foreground">{a.ip}</td>
                      <td className="p-3 text-center font-bold">{a.totalBlocked}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(a.categories).map(([cat, count]) => (
                            <Badge key={cat} className={`text-xs ${getCategoryColor(cat)}`}>
                              {cat}: {count}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 text-right text-muted-foreground text-xs">{formatTime(a.lastSeen)}</td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b last:border-0 bg-muted/10">
                        <td colSpan={4} className="p-4" data-testid={`row-anon-expanded-${a.ip}`}>
                          <IpTimeSeriesChart ip={a.ip} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CategoryOverview({ summary, dbUsers }: { summary: RateLimitSummary | undefined; dbUsers: DbUser[] }) {
  if (!summary || Object.keys(summary.categories).length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p data-testid="text-no-categories">No rate limit categories configured or no events recorded.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="list-category-overview">
      {Object.entries(summary.categories).map(([category, metrics]) => (
        <Card key={category} data-testid={`card-category-${category}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Badge className={getCategoryColor(category)}>{category}</Badge>
              <span className="text-muted-foreground text-sm font-normal">
                {metrics.maxRequests} req / {Math.round(metrics.windowMs / 60000)} min
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-xl font-bold text-foreground">{metrics.totalBlocked}</div>
                <div className="text-xs text-muted-foreground">blocked</div>
              </div>
              <div>
                <div className="text-xl font-bold">{metrics.uniqueIPs}</div>
                <div className="text-xs text-muted-foreground">unique IPs</div>
              </div>
              <div>
                <div className="text-xl font-bold">{metrics.uniqueUsers}</div>
                <div className="text-xs text-muted-foreground">unique users</div>
              </div>
            </div>

            {metrics.topUsers && metrics.topUsers.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Top Users</div>
                <div className="space-y-1">
                  {metrics.topUsers.slice(0, 5).map((tu) => (
                    <div key={tu.userId} className="flex justify-between text-xs" data-testid={`text-top-user-${category}-${tu.userId}`}>
                      <span className="text-foreground font-medium">{getUserDisplayName(tu.userId, dbUsers)}</span>
                      <span className="text-muted-foreground">{tu.count} blocked</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {metrics.topIPs && metrics.topIPs.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Top IPs</div>
                <div className="space-y-1">
                  {metrics.topIPs.slice(0, 5).map((ti) => (
                    <div key={ti.ip} className="flex justify-between text-xs">
                      <span className="font-mono">{ti.ip}</span>
                      <span className="text-muted-foreground">{ti.count} blocked</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
