import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make the build/index.js file executable
fs.chmodSync(path.join(__dirname, '..', 'build', 'index.js'), '755');

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.ensureDirSync(path.join(__dirname, '..', 'build', 'scripts'));
  
  // Copy every GDScript the server launches Godot with
  const scripts = ['godot_operations.gd', 'mcp_interaction_server.gd', 'mcp_bootstrap.gd', 'validate_script.gd'];
  for (const script of scripts) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'src', 'scripts', script),
      path.join(__dirname, '..', 'build', 'scripts', script)
    );
  }

  console.log('Successfully copied scripts to build/scripts');
} catch (error) {
  console.error('Error copying scripts:', error);
  process.exit(1);
}

console.log('Build scripts completed successfully!');
