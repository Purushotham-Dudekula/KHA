const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const code = fs.readFileSync('src/controllers/admin.controller.js', 'utf8');

const ast = parser.parse(code, {
  sourceType: 'module',
  plugins: []
});

const subControllers = {
  'admin.refund.controller.js': ['processRefund'],
  'admin.commission.controller.js': ['upsertCommission', 'getCommission'],
  'admin.operator.controller.js': ['verifyOperator', 'rejectOperator', 'getSecureOperatorDocument', 'verifyOperatorDocuments'],
  'admin.tractor.controller.js': ['verifyTractor', 'rejectTractor', 'listPendingTractors', 'getSecureTractorDocument', 'verifyTractorDocument'],
};

// We will literally string slice the file using AST node locations to preserve EXACT formatting and comments.

const funcNodes = ast.program.body.filter(n => n.type === 'FunctionDeclaration');

let files = {
  'admin.refund.controller.js': [],
  'admin.commission.controller.js': [],
  'admin.operator.controller.js': [],
  'admin.tractor.controller.js': [],
  'admin.core.controller.js': []
};

for (const node of funcNodes) {
  const name = node.id.name;
  let target = 'admin.core.controller.js';
  
  for (const [file, funcs] of Object.entries(subControllers)) {
    if (funcs.includes(name)) {
      target = file;
      break;
    }
  }
  
  const funcCode = code.slice(node.start, node.end);
  files[target].push(funcCode);
}

// Find module.exports to extract exactly what was exported for core
let originalExportsNode = ast.program.body.find(n => 
  n.type === 'ExpressionStatement' &&
  n.expression.type === 'AssignmentExpression' &&
  n.expression.left.object && n.expression.left.object.name === 'module' &&
  n.expression.left.property.name === 'exports'
);

let allExportNames = [];
if (originalExportsNode && originalExportsNode.expression.right.type === 'ObjectExpression') {
  for (const prop of originalExportsNode.expression.right.properties) {
    if (prop.key.name !== '__testables') {
      allExportNames.push(prop.key.name);
    }
  }
}

// Extract header (imports + helpers)
const firstFunc = funcNodes[0];
const headerCode = code.slice(0, firstFunc.start);

if (!fs.existsSync('src/controllers/admin')) fs.mkdirSync('src/controllers/admin');

for (const [filename, funcs] of Object.entries(files)) {
  let content = headerCode.trim() + '\n\n';
  content += funcs.join('\n\n') + '\n\n';
  
  if (filename !== 'admin.core.controller.js') {
    const exportsList = subControllers[filename];
    content += 'module.exports = {\n  ' + exportsList.join(',\n  ') + '\n};\n';
  } else {
    // Determine what core actually exports
    const coreExports = allExportNames.filter(e => {
       for (const sf of Object.values(subControllers)) {
          if (sf.includes(e)) return false;
       }
       return true;
    });
    content += 'module.exports = {\n  ' + coreExports.join(',\n  ') + ',\n';
    
    // add __testables back
    const testablesNode = originalExportsNode.expression.right.properties.find(p => p.key.name === '__testables');
    if (testablesNode) {
       content += '  __testables: ' + code.slice(testablesNode.value.start, testablesNode.value.end) + '\n';
    }
    content += '};\n';
  }
  
  fs.writeFileSync('src/controllers/admin/' + filename, content);
}

let indexContent = '';
for (const filename of Object.keys(files)) {
  const bareName = filename.replace('.js', '').replace(/\./g, '_');
  indexContent += 'const ' + bareName + ' = require("./' + filename + '");\n';
}

indexContent += '\nmodule.exports = {\n';
for (const filename of Object.keys(files)) {
  const bareName = filename.replace('.js', '').replace(/\./g, '_');
  indexContent += '  ...' + bareName + ',\n';
}
indexContent += '};\n';

fs.writeFileSync('src/controllers/admin/admin.index.js', indexContent);

console.log("AST SPLIT COMPLETE");
