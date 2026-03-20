import fs from 'fs';

async function test() {
  const formData = new FormData();
  formData.append('title', 'Test');
  formData.append('description', 'Test desc');
  formData.append('pdf', new Blob([fs.readFileSync('OS_Complete_Visual_Guide_UPPSC.pdf')]), 'test.pdf');
  
  try {
    const res = await fetch('http://localhost:3000/admin/upload', {
      method: 'POST',
      body: formData
    });
    console.log("Status:", res.status);
    console.log("Response:", await res.text());
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
