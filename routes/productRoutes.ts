import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';
 import qrcode from 'qrcode-terminal'
import JSZip from 'jszip';

export const qrCodeRouter = new Hono<{
    Bindings: {
         DATABASE_URL: string;
       AES_SECRET_KEY: string;
    }
}>();

const fetchLocationName = async (latitude: number, longitude: number) => {
     try {
         const response = await fetch(
           `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`
        );
        if (!response.ok) {
             throw new Error(`HTTP error! status: ${response.status}`);
         }
        const data = await response.json();
        return data.display_name || 'Location Name Not Found';
     } catch (error) {
         console.error('Error fetching location name:', error);
        return 'Error Fetching Location';
     }
 };

const generateQRCode = async (data : string): Promise<string> => {
    return new Promise((resolve, reject) => {
      qrcode.generate(data, { small: true }, (qrCode) => {
          if (qrCode) {
              resolve(qrCode);
           } else {
              reject(new Error("Error Generating QR Code"));
            }
        });
    });
  };
    

    qrCodeRouter.post('/api/products/sign', async (c) => {
        try {
            const { name, stationId, numberOfCodes } = await c.req.json();
           const batchId = uuidv4();
            const signedQRCodes: string[] = [];
    
             const prisma = new PrismaClient({
                  datasourceUrl: c.env.DATABASE_URL,
             }).$extends(withAccelerate());
    
           for (let i = 0; i < numberOfCodes; i++) {
                 const uuid = uuidv4();
                const qrData = { name, stationId, uuid };
                 const signedQRCode = await sign(qrData, c.env.AES_SECRET_KEY);
    
                  await prisma.product.create({
                     data: {
                         name,
                          stationId,
                         uuid,
                         signedQRCode,
                       batchId,
                       createdAt: new Date(),
                     }
                 });
                 signedQRCodes.push(signedQRCode);
      
            }
    
             const masterQRData = { batchId };
            const masterQRCode = await sign(masterQRData, c.env.AES_SECRET_KEY);
    
              await prisma.masterQRCode.create({
                  data: {
                      batchId,
                      masterQRCode,
                      createdAt: new Date(),
                   },
             });
          return c.json({
                message: `${numberOfCodes} QR codes signed and stored successfully`,
                  signedQRCodes,
                  masterQRCode,
                 batchId
             });
        } catch (error) {
            console.error('Error saving QR codes:', error);
             return c.json({ error: 'Error signing QR codes' }, 500);
       }
   });

  qrCodeRouter.get('/api/products/batch/:batchId/download', async (c) => {
       const batchId = c.req.param('batchId');
          try {
            const prisma = new PrismaClient({
                  datasourceUrl: c.env.DATABASE_URL,
             }).$extends(withAccelerate());
             const products = await prisma.product.findMany({
                 where: {
                     batchId
                   }
                });
  
               if (products.length === 0) {
                   return c.json({ error: 'No products found for this batch' }, 404);
                }
    
             const masterQRCode = await prisma.masterQRCode.findUnique({
                  where: {
                     batchId
                   }
             });
    
              const imagePaths: { filename: string; qrCode: string }[] = [];
            for (const product of products) {
                   const qrCode = await generateQRCode(product.signedQRCode);
                   imagePaths.push({filename:`${product.uuid}.png`, qrCode: qrCode})
               }
  
             if (masterQRCode) {
                const masterQrCode = await generateQRCode(masterQRCode.masterQRCode);
                  imagePaths.push({ filename: `master-${batchId}.png`, qrCode:masterQrCode })
              }
           const zip = new JSZip();
              for (const imagePath of imagePaths) {
                 zip.file(imagePath.filename, imagePath.qrCode);
              }
             const zipContent = await zip.generateAsync({ type: 'base64' });
    
            const headers = new Headers({
                 'Content-Type': 'application/zip',
                 'Content-Disposition': `attachment; filename=batch-${batchId}.zip`,
            });
            const byteString = atob(zipContent);
            const byteArray = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) {
                byteArray[i] = byteString.charCodeAt(i);
           }
          return new Response(byteArray, { headers });
        }
          catch (error) {
            console.error('Error generating batch ZIP:', error);
              return c.json({ error: 'Error generating batch ZIP file' }, 500);
          }
   });
    
     qrCodeRouter.post('/api/products/scan', async (c) => {
        const { signedQRCode, location } = await c.req.json();
        try {
            const decodedData = await verify(signedQRCode, c.env.AES_SECRET_KEY);
             const prisma = new PrismaClient({
                   datasourceUrl: c.env.DATABASE_URL,
                }).$extends(withAccelerate());
    
          const { latitude, longitude } = location;
            const locationName = await fetchLocationName(latitude,longitude)
        
            if (decodedData.batchId && !decodedData.uuid) {
                 const { batchId } = decodedData;
                   const products = await prisma.product.findMany({ where: { batchId } });
    
                    if (products.length === 0) {
                         return c.json({ error: 'No products found for this batch' }, 404);
                    }
        
                     for (const product of products) {
                         await prisma.scan.create({
                            data: {
                                productId: product.id,
                                locationLatitude: latitude,
                                locationLongitude: longitude,
                                locationName,
                               scannedAt: new Date(),
                             }
                       });
                }
    
               return c.json({
                     batch: {
                         batchId,
                         products: products.map(product => ({
                             name: product.name,
                                stationId: product.stationId,
                               uuid: product.uuid
                           }))
                        }
                  });
             }
    
           if (decodedData.uuid) {
                 const product = await prisma.product.findUnique({
                    where: { uuid: decodedData.uuid }
                 });
    
                if (!product) {
                    return c.json({ error: 'Product not found' }, 404);
               }
        
              await prisma.scan.create({
                   data: {
                        productId: product.id,
                         locationLatitude: latitude,
                         locationLongitude: longitude,
                        locationName,
                        scannedAt: new Date(),
                    }
               });
     
               return c.json({ product });
            }
        return c.json({ error: 'Unrecognized QR code type' }, 400);
      
        }
        catch (error) {
             console.error('Error verifying QR code:', error);
            return c.json({ error: 'Invalid or expired QR code' }, 400);
        }
    });
        
   qrCodeRouter.get('/api/products/scan-history', async (c) => {
        const signedQRCode = c.req.query('signedQRCode');
         try {
            const prisma = new PrismaClient({
                datasourceUrl: c.env.DATABASE_URL,
           }).$extends(withAccelerate());
           const masterQR = await prisma.masterQRCode.findUnique({
                 where: { masterQRCode: signedQRCode },
             });
    
              if (masterQR) {
                  const products = await prisma.product.findMany({
                       where: { batchId: masterQR.batchId },
                 });
    
                   const productsWithScans = await Promise.all(products.map(async (product) => {
                       const scans = await prisma.sellerScan.findMany({
                          where: { productId: product.id },
                            orderBy: { scannedAt: 'desc' },
                        });
        
                       return {
                            ...product,
                             scans: scans.map(scan => ({
                                 location: {
                                       latitude: Number(scan.locationLatitude),
                                      longitude: Number(scan.locationLongitude)
                                    },
                                   scannedAt: scan.scannedAt,
                                     locationName: scan.locationName
                                }))
                          };
                   }));
    
                   return c.json({
                      type: 'batch',
                      data: {
                            batchId: masterQR.batchId,
                           createdAt: masterQR.createdAt,
                          products: productsWithScans
                        }
                   });
             }
     
           const product = await prisma.product.findUnique({
                 where: { signedQRCode }
            });
    
              if (product) {
                  const scans = await prisma.sellerScan.findMany({
                        where: { productId: product.id },
                        orderBy: { scannedAt: 'desc' }
                   });
        
                  return c.json({
                      type: 'product',
                       data: {
                          ...product,
                           scans: scans.map(scan => ({
                                 location: {
                                    latitude: Number(scan.locationLatitude),
                                    longitude:Number(scan.locationLongitude)
                                },
                               scannedAt: scan.scannedAt,
                                 locationName: scan.locationName
                            }))
                        }
                   });
              }
    
            return c.json({
                error: 'No scan history found for this QR code'
            }, 404);
        } catch (error) {
           console.error('Error fetching scan history:', error);
            return c.json({
                error: 'Failed to fetch scan history'
           }, 500);
        }
    });

    qrCodeRouter.post('/api/products/seller-scan', async (c) => {
            const { signedQRCode, location } = await c.req.json();
             try {
               const decodedData = await verify(signedQRCode, c.env.AES_SECRET_KEY);
                const prisma = new PrismaClient({
                   datasourceUrl: c.env.DATABASE_URL,
                }).$extends(withAccelerate());
    
                if (decodedData.batchId && !decodedData.uuid) {
                     // This is a master QR code
                  const { batchId } = decodedData;
                     // Placeholder Database Retrieve (Products)
                    const products = await prisma.product.findMany({
                         where: {
                            batchId
                          }
                   });
                   if (products.length === 0) {
                         return c.json({ error: 'No products found for this batch' }, 404);
                     }
    
                     const { latitude, longitude } = location;
                  const locationName = await fetchLocationName(latitude,longitude)
    
                   for (const product of products) {
                           // Placeholder Database Insert (SellerScan)
                       await prisma.sellerScan.create({
                             data: {
                                 productId: product.id,
                                locationLatitude: latitude,
                                  locationLongitude: longitude,
                                 locationName,
                                 scannedAt: new Date(),
                             }
                       });
                   }
    
                    return c.json({
                       batch: {
                           batchId: batchId,
                             products: products.map(product => ({
                                  name: product.name,
                                stationId: product.stationId,
                                   uuid: product.uuid
                              }))
                         }
                    });
               }
    
           if (decodedData.uuid) {
                     // This is an individual product QR code
                   // Placeholder Database Retrieve (Product)
                const product = await prisma.product.findUnique({
                       where: {
                           uuid: decodedData.uuid
                         }
                   });
                  if (!product) {
                       return c.json({ error: 'Product not found' }, 404);
                    }
                    const { latitude, longitude } = location;
                  const locationName = await fetchLocationName(latitude,longitude)
    
                    // Placeholder Database Insert (SellerScan)
                  await prisma.sellerScan.create({
                       data: {
                           productId: product.id,
                           locationLatitude: latitude,
                             locationLongitude: longitude,
                           locationName,
                            scannedAt: new Date(),
                         }
                     });
                 return c.json({ product });
             }
             return c.json({ error: 'Unrecognized QR code type' }, 400);
        } catch (error) {
           console.error('Error verifying QR code:', error);
              return c.json({ error: 'Invalid or expired QR code' }, 400);
        }
    });