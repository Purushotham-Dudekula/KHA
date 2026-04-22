const multer = require("multer");

const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: memoryStorage,
  limits: {
    files: 5,
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "application/pdf",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, PDF allowed"), false);
    }
  },
});

// ✅ For operator documents
const uploadOperatorDocs = upload.fields([
  { name: "aadhaarDocument", maxCount: 1 },
  { name: "drivingLicenseDocument", maxCount: 1 },
]);

// ✅ For tractor documents
const uploadTractorDocs = upload.fields([
  { name: "rcDocument", maxCount: 1 },
  { name: "insuranceDocument", maxCount: 1 },
  { name: "pollutionDocument", maxCount: 1 },
  { name: "fitnessDocument", maxCount: 1 },
  { name: "tractorPhoto", maxCount: 1 },
]);

// ✅ Already existing
function uploadProgressImages(req, res, next) {
  if (!req.is || !req.is("multipart/form-data")) {
    return next();
  }
  return upload.array("images", 5)(req, res, next);
}

module.exports = {
  uploadOperatorDocs,
  uploadTractorDocs,
  uploadProgressImages,
};