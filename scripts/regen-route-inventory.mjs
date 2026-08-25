import { parseRoutes, generateInventoryReport } from '../tests/route-inventory.ts';
import * as fs from 'fs';
const r = parseRoutes();
console.log('Total routes:', r.length);
fs.writeFileSync('tests/route-inventory.json', JSON.stringify(r, null, 2));
fs.writeFileSync('tests/route-inventory-report.md', generateInventoryReport(r));
