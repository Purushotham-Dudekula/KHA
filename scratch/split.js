const fs = require('fs');

const file = fs.readFileSync('src/controllers/admin.controller.js', 'utf8');
const lines = file.split('\n');

const extractFunctions = [
  // Refund
  { name: 'processRefund', target: 'admin.refund.controller.js' },
  // Commission
  { name: 'upsertCommission', target: 'admin.commission.controller.js' },
  { name: 'getCommission', target: 'admin.commission.controller.js' },
  // Operator
  { name: 'verifyOperator', target: 'admin.operator.controller.js' },
  { name: 'rejectOperator', target: 'admin.operator.controller.js' },
  { name: 'getSecureOperatorDocument', target: 'admin.operator.controller.js' },
  { name: 'verifyOperatorDocuments', target: 'admin.operator.controller.js' },
  // Tractor
  { name: 'verifyTractor', target: 'admin.tractor.controller.js' },
  { name: 'rejectTractor', target: 'admin.tractor.controller.js' },
  { name: 'getSecureTractorDocument', target: 'admin.tractor.controller.js' },
  { name: 'verifyTractorDocument', target: 'admin.tractor.controller.js' },
];

let files = {
  'admin.refund.controller.js': [],
  'admin.commission.controller.js': [],
  'admin.operator.controller.js': [],
  'admin.tractor.controller.js': [],
  'admin.core.controller.js': [],
};

const commonImports = `const mongoose = require("mongoose");
const Admin = require("../../models/admin.model");
const User = require("../../models/user.model");
const Tractor = require("../../models/tractor.model");
const Booking = require("../../models/booking.model");
const Complaint = require("../../models/complaint.model");
const Payment = require("../../models/payment.model");
const Pricing = require("../../models/pricing.model");
const Commission = require("../../models/commission.model");
const SeasonalPricing = require("../../models/seasonalPricing.model");
const AdminAuditLog = require("../../models/adminAuditLog.model");
const AdminActivityLog = require("../../models/adminActivityLog.model");
const { logAdminAction } = require("../../services/adminAuditLog.service");
const {
  hasOperatorDocumentsForApproval,
  validateTractorForApproval,
  deriveTractorVerificationFromDocuments,
} = require("../../utils/verification");
const { cleanUserResponse } = require("../../utils/cleanUserResponse");
const { sendSuccess } = require("../../utils/apiResponse");
const { logger } = require("../../utils/logger");
const { notifyUser } = require("../../services/notification.service");
const { refundUpiPayment } = require("../../services/payment.service");
const { logRefundSuccess } = require("../../services/ledger.service");
const { resolveRefundSnapshot } = require("../../utils/refundCalculation");
const { getSecureFileUrl } = require("../../services/storage.service");
const { AppError } = require("../../utils/AppError");
const { logAdminActivity } = require("../../services/adminActivityLog.service");
const { logAuditAction } = require("../../services/auditLog.service");
const { invalidateUserAuthCache } = require("../../middleware/auth.middleware");

`;

let currentFunc = null;
let currentBraceCount = 0;
let currentBuffer = [];

let inModuleExports = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (line.startsWith('module.exports = {') && currentBraceCount === 0) {
    inModuleExports = true;
    continue;
  }

  if (inModuleExports) {
    // Ignore module.exports, we'll generate it later
    continue;
  }

  // Are we looking for a function?
  if (!currentFunc && line.startsWith('async function ')) {
    const match = line.match(/^async function ([a-zA-Z0-9_]+)\s*\(/);
    if (match) {
      const funcName = match[1];
      const target = extractFunctions.find(f => f.name === funcName);
      if (target) {
        currentFunc = target.target;
      } else {
        currentFunc = 'admin.core.controller.js';
      }
    }
  }

  if (!currentFunc) {
      // Top level things like imports or helper functions
      // We push to all files or handle separately? 
      // Helper functions like parsePagination are not async
      if (line.startsWith('function ')) {
          files['admin.core.controller.js'].push(line);
      } else if (!line.startsWith('const ') && line.trim() !== '') {
          files['admin.core.controller.js'].push(line);
      }
  } else {
    currentBuffer.push(line);
    
    // Count braces
    for (let char of line) {
      if (char === '{') currentBraceCount++;
      if (char === '}') currentBraceCount--;
    }

    if (currentBraceCount === 0 && currentBuffer.length > 0) {
      // Function ended
      files[currentFunc].push(...currentBuffer);
      files[currentFunc].push(''); // empty line
      currentBuffer = [];
      currentFunc = null;
    }
  }
}

// Ensure dir exists
if (!fs.existsSync('src/controllers/admin')) fs.mkdirSync('src/controllers/admin');

// Write files
const indexExports = [];

for (const [filename, content] of Object.entries(files)) {
  const exportsForFile = extractFunctions.filter(f => f.target === filename).map(f => f.name);
  if (filename === 'admin.core.controller.js') {
     // core has everything else
     const allTargets = extractFunctions.map(f => f.name);
     // read original exports to see what was exported
     // Actually, we'll just parse the original module.exports to keep it exactly identical
  }
  
  let finalContent = commonImports + content.join('\n');
  
  if (filename !== 'admin.core.controller.js') {
     finalContent += '\nmodule.exports = {\n  ' + exportsForFile.join(',\n  ') + '\n};\n';
  } else {
     // For core, let's just grep the original file for all exported names
     // We will do this via a simpler mechanism later
  }

  fs.writeFileSync('src/controllers/admin/' + filename, finalContent);
}

// Write the index.js
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

console.log("Done splitting files!");
