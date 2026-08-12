window.LC = window.LC || {};

LC.cloudinary = {
  uploadImage(file, cb) {
    const cfg = LC.db.config.get();
    if (!cfg.cloudName || cfg.cloudName.indexOf("YOUR") === 0 || !cfg.uploadPreset || cfg.uploadPreset.indexOf("YOUR") === 0) {
      cb({ message: "Photo uploads are not connected yet. This will work once the backend is added." });
      return;
    }
    const url = "https://api.cloudinary.com/v1_1/" + encodeURIComponent(cfg.cloudName) + "/image/upload";
    const fd = new FormData();
    fd.append("file", file);
    fd.append("upload_preset", cfg.uploadPreset);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (d.secure_url) cb(null, d.secure_url);
        else cb({ message: "Upload failed: " + (d.error && d.error.message ? d.error.message : xhr.status) });
      } catch (e) {
        cb({ message: "Upload failed (" + xhr.status + "). Check your Cloudinary settings." });
      }
    };
    xhr.onerror = () => cb({ message: "Network error while uploading to Cloudinary." });
    xhr.send(fd);
  }
};
