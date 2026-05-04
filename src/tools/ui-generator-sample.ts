import { UIGeneratorTool, createSampleUIRequest } from './ui-generator';
import type { UIGenerationRequest } from './schemas/ui-generation';

const sampleRequest = createSampleUIRequest();

console.log('=== Sample UI Generation Request ===');
console.log(JSON.stringify(sampleRequest, null, 2));

console.log('\n=== UI Container Structure ===');
console.log(`Container Type: ${sampleRequest.uiContainer.type}`);
console.log(`Container Name: ${sampleRequest.uiContainer.name}`);
console.log(`Element Count: ${sampleRequest.uiContainer.elements.length}`);
console.log(`Scaling Config: ${JSON.stringify(sampleRequest.scalingConfig, null, 2)}`);

console.log('\n=== Element Hierarchy ===');
for (const element of sampleRequest.uiContainer.elements) {
  console.log(`- ${element.type}: ${element.name} (id: ${element.id})`);
  if ('parentId' in element && element.parentId) {
    console.log(`  Parent: ${element.parentId}`);
  }
  if ('content' in element && element.content?.text) {
    console.log(`  Text: "${element.content.text}"`);
  }
  if ('animations' in element && element.animations) {
    console.log(`  Animations: ${element.animations.length}`);
  }
}

console.log('\n=== Color Palette ===');
const bgColor = (sampleRequest.uiContainer.elements[0] as any).backgroundColor;
console.log(`Background: RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`);

const buttonColor = (sampleRequest.uiContainer.elements[3] as any).backgroundColor;
console.log(`Button: RGB(${buttonColor.r}, ${buttonColor.g}, ${buttonColor.b})`);

console.log('\n=== Test Validation ===');
const tool = new UIGeneratorTool({} as any);

async function runValidation() {
  const validation = await tool.validateUIRequest(sampleRequest);
  console.log(`Valid: ${validation.valid}`);
  console.log(`Errors: ${validation.errors.length > 0 ? validation.errors.join(', ') : 'none'}`);
  console.log(`Warnings: ${validation.warnings.length > 0 ? validation.warnings.join(', ') : 'none'}`);

  const preview = await tool.previewUI(sampleRequest);
  console.log(`\nPreview Data:`);
  console.log(`- Element Count: ${preview.elementCount}`);
  console.log(`- Animations: ${preview.animationsCount}`);
  console.log(`- Complexity: ${preview.estimatedComplexity}`);
}

runValidation().catch(console.error);

export { sampleRequest };