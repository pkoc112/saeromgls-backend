const https = require('https');

const EP = 'https://ep-falling-wind-am644wzp.c-5.us-east-1.aws.neon.tech/sql';
const CONN = 'postgresql://neondb_owner:npg_gWPeBp9aAfn3@ep-falling-wind-am644wzp.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require';

function runSQL(sql, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql, params });
    const url = new URL(EP);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': CONN, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(data); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function seed() {
  const adminPin = '$2b$10$p848GUGnrsSTRiniR9dm/.D8joz1ivABOLQXfP/Aeh6e0.jOj7Vf6';
  const supPin = '$2b$10$r4taOlR.bDnJU/Z.gAyKl.QyPqSjYYBWCRjCfG0uFI589koWWOh6u';
  const wrkPin = '$2b$10$50v17LUq.kR7R6EZSNS8HeSWFWe1NU2x1jqMmcNf3yDwb54m7Fq3e';

  const workers = [
    ['관리자', 'ADM001', adminPin, 'MASTER'],
    ['반장김', 'SUP001', supPin, 'SUPERVISOR'],
    ['강재구', 'WRK101', wrkPin, 'WORKER'],
    ['공대용', 'WRK102', wrkPin, 'WORKER'],
    ['권승렬', 'WRK103', wrkPin, 'WORKER'],
    ['김대호', 'WRK104', wrkPin, 'WORKER'],
    ['김병우', 'WRK105', wrkPin, 'WORKER'],
    ['김진욱', 'WRK106', wrkPin, 'WORKER'],
    ['남상욱', 'WRK107', wrkPin, 'WORKER'],
    ['박근남', 'WRK108', wrkPin, 'WORKER'],
    ['심원식', 'WRK109', wrkPin, 'WORKER'],
    ['전영길', 'WRK110', wrkPin, 'WORKER'],
    ['주원호', 'WRK111', wrkPin, 'WORKER'],
    ['최민', 'WRK112', wrkPin, 'WORKER'],
    ['허경희', 'WRK113', wrkPin, 'WORKER'],
  ];

  for (const [name, code, pin, role] of workers) {
    const r = await runSQL(
      "INSERT INTO workers (id, name, employee_code, pin, role, status, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ACTIVE', NOW(), NOW()) ON CONFLICT (employee_code) DO UPDATE SET name=$1, updated_at=NOW()",
      [name, code, pin, role]
    );
    console.log(`${name} (${code}): ${r.command || r.message || 'ok'}`);
  }

  // Top-level category classifications (DO UPDATE to fix displayName format with prefix)
  const topCats = [
    ['DC',      '[DC] DC (물류센터)',        1],
    ['AGENCY',  '[대리점] 대리점',            2],
    ['CVS',     '[CVS] CVS (편의점)',         3],
    ['LOCAL',   '[지방이고] 지방이고',         4],
    ['EMART',   '[이마트] 이마트',            5],
    ['COUPANG', '[쿠팡] 쿠팡',               6],
  ];

  for (const [code, name, order] of topCats) {
    const r = await runSQL(
      "INSERT INTO classifications (id, code, display_name, sort_order, is_active, created_at) VALUES (gen_random_uuid(), $1, $2, $3, true, NOW()) ON CONFLICT (code) DO UPDATE SET display_name=$2, sort_order=$3, is_active=true",
      [code, name, order]
    );
    console.log(`Category ${code}: ${r.command || r.message || 'ok'}`);
  }

  // Child classifications (DO NOTHING to preserve any user edits)
  const cls = [
    ['DC_001', '[DC] 건과)DC_포항', 10], ['DC_002', '[DC] 건과)DC_동부', 11],
    ['DC_003', '[DC] 건과)DC_서부', 12], ['DC_004', '[DC] 건과)DC_안동', 13],
    ['LOCAL_005', '[지방이고] 건과)광명', 14], ['LOCAL_006', '[지방이고] 건과)의왕', 15],
    ['AGENCY_020', '[대리점] 롯데웰푸드 영천대리점', 29],
    ['AGENCY_021', '[대리점] 주식회사 상도대리점', 30],
    ['COUPANG_029', '[쿠팡] 쿠팡 대구1센터', 38],
    ['EMART_010', '[이마트] 이마트 대구센터(건과)', 19],
  ];

  for (const [code, name, order] of cls) {
    const r = await runSQL(
      "INSERT INTO classifications (id, code, display_name, sort_order, is_active, created_at) VALUES (gen_random_uuid(), $1, $2, $3, true, NOW()) ON CONFLICT (code) DO NOTHING",
      [code, name, order]
    );
    console.log(`Classification ${code}: ${r.command || r.message || 'ok'}`);
  }

  // Verify
  const count = await runSQL("SELECT COUNT(*) as cnt FROM workers");
  console.log(`\nTotal workers: ${count.rows[0].cnt}`);
}

seed().catch(e => console.error(e));
