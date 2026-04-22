const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const code = fs.readFileSync('src/controllers/booking.controller.js', 'utf8');

const ast = parser.parse(code, {
  sourceType: 'module',
  plugins: []
});

const subControllers = {
  'booking.create.controller.js': ['createBooking', 'estimateBooking'],
  'booking.payment.controller.js': ['payAdvance', 'payRemaining', 'getBookingRefundPreview'],
  'booking.status.controller.js': ['respondToBooking', 'startJob', 'completeJob', 'cancelBooking', 'updateBookingProgress'],
  'booking.query.controller.js': [
    'getBookingDetails', 
    'getBookingInvoice', 
    'listFarmerBookings', 
    'listOperatorBookings', 
    'listMyFarmerBookings', 
    'listMyOperatorBookings', 
    'trackBooking'
  ]
};

const funcNodes = ast.program.body.filter(n => n.type === 'FunctionDeclaration' && n.async);

let files = {
  'booking.create.controller.js': [],
  'booking.payment.controller.js': [],
  'booking.status.controller.js': [],
  'booking.query.controller.js': []
};

for (const node of funcNodes) {
  const name = node.id.name;
  let target = null;
  
  for (const [file, funcs] of Object.entries(subControllers)) {
    if (funcs.includes(name)) {
      target = file;
      break;
    }
  }
  
  if (!target) {
     console.log('UNMAPPED FUNCTION:', name);
     // Let's just put it in query by default if unmapped, or maybe core
     target = 'booking.query.controller.js';
     subControllers['booking.query.controller.js'].push(name);
  }
  
  const funcCode = code.slice(node.start, node.end);
  files[target].push(funcCode);
}

let originalExportsNode = ast.program.body.find(n => 
  n.type === 'ExpressionStatement' &&
  n.expression.type === 'AssignmentExpression' &&
  n.expression.left.object && n.expression.left.object.name === 'module' &&
  n.expression.left.property.name === 'exports'
);

let __testablesCode = null;
if (originalExportsNode && originalExportsNode.expression.right.type === 'ObjectExpression') {
  const testablesNode = originalExportsNode.expression.right.properties.find(p => p.key.name === '__testables');
  if (testablesNode) {
     __testablesCode = code.slice(testablesNode.value.start, testablesNode.value.end);
  }
}

const firstFunc = funcNodes[0];
let headerCode = code.slice(0, firstFunc.start);
headerCode = headerCode.replace(/require\(['"]\.\.\/([^'"]+)['"]\)/g, 'require("../../$1")');
headerCode = headerCode.replace(/require\(['"]\.\/([^'"]+)['"]\)/g, 'require("../$1")');

if (!fs.existsSync('src/controllers/booking')) fs.mkdirSync('src/controllers/booking');

for (const [filename, funcs] of Object.entries(files)) {
  let content = headerCode.trim() + '\n\n';
  content += funcs.join('\n\n') + '\n\n';
  
  const exportsList = subControllers[filename];
  content += 'module.exports = {\n  ' + exportsList.join(',\n  ');
  
  if (filename === 'booking.status.controller.js' && __testablesCode) {
     content += ',\n  __testables: ' + __testablesCode;
  }
  
  content += '\n};\n';
  
  fs.writeFileSync('src/controllers/booking/' + filename, content);
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

fs.writeFileSync('src/controllers/booking/booking.index.js', indexContent);

console.log("AST SPLIT COMPLETE");
