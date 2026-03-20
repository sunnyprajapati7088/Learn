import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

async function upload() {
  try {
    const form = new FormData();
    form.append('title', 'Test Book');
    form.append('description', 'A test upload to catch the real error.');
    form.append('pdf', fs.createReadStream('OS_Complete_Visual_Guide_UPPSC.pdf'));

    console.log("Sending request to http://localhost:3000/admin/upload...");
    const res = await fetch('http://localhost:3000/admin/upload', {
        method: 'POST',
        body: form,
    });
    
    const text = await res.text();
    console.log("HTTP Status:", res.status);
    console.log("Response Body:", text);
  } catch(e) {
    console.error("Fetch failed:", e);
  }
}
upload();
