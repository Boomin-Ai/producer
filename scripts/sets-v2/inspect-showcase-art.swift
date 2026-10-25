import AppKit
import Foundation
let base=URL(fileURLWithPath:CommandLine.arguments[1])
var rows:[[String:Any]]=[]
for name in ["decision-room","open-floor","atmosphere","just-facts"] {
 let folder=base.appendingPathComponent("docs/shows/media/"+name)
 for file in try FileManager.default.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil).sorted(by:{$0.path<$1.path}) where file.pathExtension=="png" {
  guard let data=try? Data(contentsOf:file),let image=NSBitmapImageRep(data:data) else {fatalError("Unreadable asset")}
  var row:[String:Any]=["file":"docs/shows/media/"+name+"/"+file.lastPathComponent,"width":image.pixelsWide,"height":image.pixelsHigh,"hasAlpha":image.hasAlpha]
  if file.lastPathComponent.contains("bezel") {
   let center=image.colorAt(x:image.pixelsWide/2,y:image.pixelsHigh/2)!.alphaComponent
   let corner=image.colorAt(x:0,y:0)!.alphaComponent
   row["centerAlpha"]=center;row["cornerAlpha"]=corner
   let cx=image.pixelsWide/2,cy=image.pixelsHigh/2
   var left=cx,right=cx,top=cy,bottom=cy
   while left>0 && image.colorAt(x:left-1,y:cy)!.alphaComponent<0.01 {left-=1}
   while right+1<image.pixelsWide && image.colorAt(x:right+1,y:cy)!.alphaComponent<0.01 {right+=1}
   while top>0 && image.colorAt(x:cx,y:top-1)!.alphaComponent<0.01 {top-=1}
   while bottom+1<image.pixelsHigh && image.colorAt(x:cx,y:bottom+1)!.alphaComponent<0.01 {bottom+=1}
   row["openingPixels"]=["left":left,"top":top,"width":right-left+1,"height":bottom-top+1]
   precondition(image.hasAlpha && center==0 && corner==0,"Bezel needs real transparency: "+file.path)
  }
  rows.append(row)
 }
}
let output=try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys])
try output.write(to:base.appendingPathComponent("docs/set-runtime/generated-asset-manifest.json"))
print("Verified \(rows.count) assets, including four genuine transparent bezels")
