const fs = require('fs');
const files = fs.readdirSync('src/controllers/admin').filter(f => f !== 'admin.index.js');
for (const f of files) {
  const p = 'src/controllers/admin/' + f;
  let c = fs.readFileSync(p, 'utf8');
  c = c.replace(/require\(['"]\.\.\/([^'"]+)['"]\)/g, 'require("../../$1")');
  fs.writeFileSync(p, c);
}
console.log('Replaced imports');
