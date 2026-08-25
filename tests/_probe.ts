import { isRedisConfigured, getRedisCacheMetrics } from "../server/services/cache/redisCache";
import { isPoolEpicSwitchEnabled } from "../server/services/poolEpicKillSwitches";
console.log("redis configured=", isRedisConfigured());
console.log("kill switch redis_cache_enabled=", isPoolEpicSwitchEnabled("redis_cache_enabled"));
console.log("metrics=", JSON.stringify(getRedisCacheMetrics(), null, 2));
